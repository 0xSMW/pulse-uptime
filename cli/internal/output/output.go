package output

import (
	"encoding/json"
	"fmt"
	"io"
)

type ErrorDocument struct {
	APIVersion string      `json:"apiVersion" yaml:"apiVersion"`
	Kind       string      `json:"kind" yaml:"kind"`
	Error      ErrorObject `json:"error" yaml:"error"`
}

type ErrorObject struct {
	Code      string `json:"code" yaml:"code"`
	Message   string `json:"message" yaml:"message"`
	Details   any    `json:"details,omitempty" yaml:"details,omitempty"`
	RequestID string `json:"requestId,omitempty" yaml:"requestId,omitempty"`
}

func JSON(w io.Writer, value any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

func HumanError(w io.Writer, message string) {
	fmt.Fprintf(w, "Error: %s\n", message)
}
