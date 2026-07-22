package interactive

import (
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// statFile is swappable in tests so file validation needs no fixtures.
var statFile = func(path string) (fs.FileInfo, error) { return os.Stat(path) }

// ValidateRequired rejects empty and whitespace-only input.
func ValidateRequired(field string) func(string) error {
	return func(s string) error {
		if strings.TrimSpace(s) == "" {
			return fmt.Errorf("%s is required", field)
		}
		return nil
	}
}

// ValidateURL accepts absolute http or https URLs with a host.
func ValidateURL(s string) error {
	if strings.TrimSpace(s) == "" {
		return fmt.Errorf("URL is required")
	}
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil {
		return fmt.Errorf("invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("URL must start with http:// or https://")
	}
	if u.Host == "" {
		return fmt.Errorf("URL must include a host")
	}
	return nil
}

// ValidateOptionalURL accepts empty input or a valid http or https URL.
func ValidateOptionalURL(s string) error {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return ValidateURL(s)
}

// ValidateDuration accepts Go duration syntax greater than zero, e.g. 30s or 5m.
func ValidateDuration(s string) error {
	if strings.TrimSpace(s) == "" {
		return fmt.Errorf("duration is required")
	}
	d, err := time.ParseDuration(strings.TrimSpace(s))
	if err != nil {
		return fmt.Errorf("invalid duration, use forms like 30s or 5m")
	}
	if d <= 0 {
		return fmt.Errorf("duration must be positive")
	}
	return nil
}

// ValidateOptionalDuration accepts empty input or a positive Go duration.
func ValidateOptionalDuration(s string) error {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return ValidateDuration(s)
}

// ValidatePositiveInt accepts a base ten integer greater than zero.
func ValidatePositiveInt(s string) error {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return fmt.Errorf("must be a whole number")
	}
	if n <= 0 {
		return fmt.Errorf("must be greater than zero")
	}
	return nil
}

// ValidateOptionalPositiveInt accepts empty input or a positive integer.
func ValidateOptionalPositiveInt(s string) error {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return ValidatePositiveInt(s)
}

// ValidateIntRange accepts a base ten integer within the inclusive range.
func ValidateIntRange(minimum, maximum int) func(string) error {
	return func(s string) error {
		n, err := strconv.Atoi(strings.TrimSpace(s))
		if err != nil {
			return fmt.Errorf("must be a whole number")
		}
		if n < minimum || n > maximum {
			return fmt.Errorf("must be between %d and %d", minimum, maximum)
		}
		return nil
	}
}

// ValidateOptionalStatusRange accepts empty input, a single HTTP status, or a
// low-high range such as 200-399 within 100 to 599.
func ValidateOptionalStatusRange(s string) error {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return nil
	}
	parts := strings.SplitN(trimmed, "-", 2)
	bounds := make([]int, 0, 2)
	for _, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 100 || n > 599 {
			return fmt.Errorf("use a status or range between 100 and 599, e.g. 200-399")
		}
		bounds = append(bounds, n)
	}
	if len(bounds) == 2 && bounds[0] > bounds[1] {
		return fmt.Errorf("range low bound must not exceed the high bound")
	}
	return nil
}

// ValidateOptionalRFC3339 accepts empty input or an RFC 3339 timestamp.
func ValidateOptionalRFC3339(s string) error {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return nil
	}
	if _, err := time.Parse(time.RFC3339, trimmed); err != nil {
		return fmt.Errorf("use RFC 3339, e.g. 2026-01-02T15:04:05Z")
	}
	return nil
}

// ValidateExistingFile accepts a path to an existing regular file.
func ValidateExistingFile(s string) error {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return fmt.Errorf("file path is required")
	}
	info, err := statFile(trimmed)
	if err != nil {
		return fmt.Errorf("file not found")
	}
	if info.IsDir() {
		return fmt.Errorf("path is a directory")
	}
	return nil
}

// ValidateOptionalEmail accepts empty input or a plausible email address.
func ValidateOptionalEmail(s string) error {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return nil
	}
	at := strings.Index(trimmed, "@")
	if at <= 0 || at == len(trimmed)-1 || strings.ContainsAny(trimmed, " \t") {
		return fmt.Errorf("invalid email address")
	}
	return nil
}
