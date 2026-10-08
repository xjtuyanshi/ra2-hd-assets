package main

import "testing"

func TestCommandLine(t *testing.T) {
	cases := map[string]string{
		"":           `""`,
		"中文 space":   `"中文 space"`,
		`C:\game\`:   `"C:\game\\"`,
		`a\"b`:       `"a\\\"b"`,
		`gamemd.exe`: `"gamemd.exe"`,
	}
	for input, expected := range cases {
		if actual := quoteArgument(input); actual != expected {
			t.Errorf("quoteArgument(%q) = %q; want %q", input, actual, expected)
		}
	}
	if actual := commandLine([]string{`C:\two words\gamemd.exe`, "-SPEEDCONTROL"}); actual != `"C:\two words\gamemd.exe" "-SPEEDCONTROL"` {
		t.Fatal(actual)
	}
}
