package interactive

import "testing"

func TestShouldLaunch(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	cases := []struct {
		name   string
		args   []string
		stdin  bool
		stdout bool
		stderr bool
		env    map[string]string
		want   bool
	}{
		{name: "bare tty launches", args: nil, stdin: true, stdout: true, stderr: true, want: true},
		{name: "any arg keeps scripted path", args: []string{"monitor"}, stdin: true, stdout: true, stderr: true, want: false},
		{name: "help flag keeps scripted path", args: []string{"--help"}, stdin: true, stdout: true, stderr: true, want: false},
		{name: "piped stdout keeps scripted path", args: nil, stdin: true, stdout: false, stderr: true, want: false},
		{name: "piped stdin keeps scripted path", args: nil, stdin: false, stdout: true, stderr: true, want: false},
		{name: "piped stderr keeps scripted path", args: nil, stdin: true, stdout: true, stderr: false, want: false},
		{name: "no input escape hatch", args: nil, stdin: true, stdout: true, stderr: true, env: map[string]string{"PULSECTL_NO_INPUT": "1"}, want: false},
		{name: "dumb terminal keeps scripted path", args: nil, stdin: true, stdout: true, stderr: true, env: map[string]string{"TERM": "dumb"}, want: false},
		{name: "no color still launches", args: nil, stdin: true, stdout: true, stderr: true, env: map[string]string{"NO_COLOR": "1"}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ShouldLaunch(tc.args, tc.stdin, tc.stdout, tc.stderr, env(tc.env))
			if got != tc.want {
				t.Fatalf("ShouldLaunch = %v, want %v", got, tc.want)
			}
		})
	}
}
