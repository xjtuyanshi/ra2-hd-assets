package main

import "strings"

// quoteArgument follows CreateProcess/CommandLineToArgvW quoting, including
// trailing backslashes. The executable and each player argument stay separate.
func quoteArgument(value string) string {
	var result strings.Builder
	result.WriteByte('"')
	slashes := 0
	for _, char := range value {
		if char == '\\' {
			slashes++
			continue
		}
		if char == '"' {
			result.WriteString(strings.Repeat("\\", slashes*2+1))
		} else {
			result.WriteString(strings.Repeat("\\", slashes))
		}
		slashes = 0
		result.WriteRune(char)
	}
	result.WriteString(strings.Repeat("\\", slashes*2))
	result.WriteByte('"')
	return result.String()
}

func commandLine(arguments []string) string {
	quoted := make([]string, len(arguments))
	for index, argument := range arguments {
		quoted[index] = quoteArgument(argument)
	}
	return strings.Join(quoted, " ")
}
