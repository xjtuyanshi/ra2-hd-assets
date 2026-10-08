// The original launcher-handshake implementation comes from the project's
// private Wine feasibility helper. This version owns only the process it starts.
package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

const (
	mutexName     = "48BC11BD-C4D7-466b-8A31-C6ABBAD47B3E"
	eventName     = "D6E7FC97-64F9-4d28-B52C-754EDF721C6F"
	protectedData = "UIDATA,3DDATA,MAPS"
	wmBeef        = 0xBEEF
)

var (
	kernel            = syscall.NewLazyDLL("kernel32.dll")
	createMutex       = kernel.NewProc("CreateMutexW")
	createEvent       = kernel.NewProc("CreateEventW")
	createJob         = kernel.NewProc("CreateJobObjectW")
	setJobInformation = kernel.NewProc("SetInformationJobObject")
	assignJob         = kernel.NewProc("AssignProcessToJobObject")
	resumeThread      = kernel.NewProc("ResumeThread")
	postThreadMessage = syscall.NewLazyDLL("user32.dll").NewProc("PostThreadMessageW")
)

type launchStatus struct {
	PID       uint32 `json:"pid"`
	Handshake bool   `json:"handshake"`
	Running   bool   `json:"running"`
	ExitCode  uint32 `json:"exitCode"`
}

func writeStatus(path string, status launchStatus) error {
	if path == "" {
		return nil
	}
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	if err = os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

func stopped(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func launch() error {
	stopPath := flag.String("stop-file", "", "Private stop-file path; terminates only the owned game")
	statusPath := flag.String("status-file", "", "Private JSON process-status path")
	logPath := flag.String("log", "", "Private launch-log path")
	flag.Parse()
	if flag.NArg() < 1 {
		return fmt.Errorf("usage: ra2launch [--stop-file PATH --status-file PATH --log PATH] GAME.exe [arguments]")
	}
	if *logPath != "" {
		log, err := os.OpenFile(*logPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		originalStderr := os.Stderr
		defer func() {
			os.Stderr = originalStderr
			log.Close()
		}()
		os.Stderr = log
	}
	say := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, time.Now().Format(time.RFC3339Nano)+" "+format+"\n", args...)
	}

	mutexString, _ := syscall.UTF16PtrFromString(mutexName)
	eventString, _ := syscall.UTF16PtrFromString(eventName)
	mutex, _, mutexError := createMutex.Call(0, 0, uintptr(unsafe.Pointer(mutexString)))
	if mutex == 0 {
		return fmt.Errorf("CreateMutexW: %v", mutexError)
	}
	defer syscall.CloseHandle(syscall.Handle(mutex))
	if mutexError == syscall.Errno(183) {
		return fmt.Errorf("an original launcher/game already owns this Wine session; use a dedicated bottle or stop it first")
	}
	event, _, eventError := createEvent.Call(0, 1, 0, uintptr(unsafe.Pointer(eventString)))
	if event == 0 {
		return fmt.Errorf("CreateEventW: %v", eventError)
	}
	defer syscall.CloseHandle(syscall.Handle(event))

	attributes := syscall.SecurityAttributes{InheritHandle: 1}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	mapping, err := syscall.CreateFileMapping(syscall.InvalidHandle, &attributes, syscall.PAGE_READWRITE, 0, 4096, nil)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(mapping)
	view, err := syscall.MapViewOfFile(mapping, syscall.FILE_MAP_WRITE, 0, 0, 0)
	if err != nil {
		return err
	}
	defer syscall.UnmapViewOfFile(view)
	copy(unsafe.Slice((*byte)(unsafe.Pointer(view)), 4096), append([]byte(protectedData), 0))

	// 32-bit JOBOBJECT_EXTENDED_LIMIT_INFORMATION, as defined by the MinGW
	// Win32 headers: 112 bytes, BasicLimitInformation.LimitFlags at byte 16.
	// Closing the non-inherited job handle also closes our game if the helper dies.
	job, _, jobError := createJob.Call(0, 0)
	if job == 0 {
		return fmt.Errorf("CreateJobObjectW: %v", jobError)
	}
	defer syscall.CloseHandle(syscall.Handle(job))
	var limits [112]byte
	binary.LittleEndian.PutUint32(limits[16:20], 0x2000) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if ok, _, err := setJobInformation.Call(job, 9, uintptr(unsafe.Pointer(&limits[0])), uintptr(len(limits))); ok == 0 {
		return fmt.Errorf("SetInformationJobObject: %v", err)
	}

	exe, err := filepath.Abs(flag.Arg(0))
	if err != nil {
		return err
	}
	exeString, err := syscall.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	directory, _ := syscall.UTF16PtrFromString(filepath.Dir(exe))
	arguments := append([]string{exe}, flag.Args()[1:]...)
	command, err := syscall.UTF16PtrFromString(commandLine(arguments))
	if err != nil {
		return err
	}
	startup := syscall.StartupInfo{Cb: uint32(unsafe.Sizeof(syscall.StartupInfo{}))}
	var process syscall.ProcessInformation
	// Assign the process before it executes, so a failed job assignment cannot
	// leave a detached game or partially completed launcher handshake behind.
	if err = syscall.CreateProcess(exeString, command, nil, nil, true, 4, nil, directory, &startup, &process); err != nil {
		return fmt.Errorf("CreateProcess: %w", err)
	}
	defer syscall.CloseHandle(process.Process)
	defer syscall.CloseHandle(process.Thread)
	if ok, _, err := assignJob.Call(job, uintptr(process.Process)); ok == 0 {
		syscall.TerminateProcess(process.Process, 1)
		return fmt.Errorf("AssignProcessToJobObject: %v", err)
	}
	if result, _, err := resumeThread.Call(uintptr(process.Thread)); result == 0xffffffff {
		return fmt.Errorf("ResumeThread: %v", err)
	}
	status := launchStatus{PID: process.ProcessId, Running: true}
	if err = writeStatus(*statusPath, status); err != nil {
		return err
	}
	say("started pid=%d tid=%d executable=%s", process.ProcessId, process.ThreadId, exe)

	start := time.Now()
	posts := 0
	for time.Since(start) < 60*time.Second && !stopped(*stopPath) {
		if event, _ := syscall.WaitForSingleObject(process.Process, 0); event == syscall.WAIT_OBJECT_0 {
			break
		}
		signalled, _ := syscall.WaitForSingleObject(syscall.Handle(event), 50)
		if signalled == syscall.WAIT_OBJECT_0 || time.Since(start) > 4*time.Second {
			ok, _, _ := postThreadMessage.Call(uintptr(process.ThreadId), wmBeef, 0, uintptr(mapping))
			if ok != 0 {
				posts++
				if signalled == syscall.WAIT_OBJECT_0 || posts >= 40 {
					status.Handshake = true
					break
				}
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	if err = writeStatus(*statusPath, status); err != nil {
		return err
	}
	if !status.Handshake && !stopped(*stopPath) {
		return fmt.Errorf("original launcher handshake did not complete")
	}
	say("launcher handshake after %.3fs", time.Since(start).Seconds())
	for {
		if stopped(*stopPath) {
			say("private stop request; terminating owned pid=%d", process.ProcessId)
			if err = syscall.TerminateProcess(process.Process, 0); err != nil {
				return err
			}
		}
		if result, err := syscall.WaitForSingleObject(process.Process, 100); result == syscall.WAIT_OBJECT_0 {
			break
		} else if err != nil {
			return err
		}
	}
	status.Running = false
	syscall.GetExitCodeProcess(process.Process, &status.ExitCode)
	say("owned game exited code=%d", status.ExitCode)
	return writeStatus(*statusPath, status)
}

func main() {
	if err := launch(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
