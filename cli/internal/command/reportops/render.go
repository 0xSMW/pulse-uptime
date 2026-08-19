package reportops

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
)

func renderEnvelope(d Dependencies, format string, doc Envelope) error {
	if handled, err := output.RenderStructured(d.Out, format, doc); handled {
		return err
	}
	switch format {
	case "tsv":
		if doc.Kind == "StatusReportDeleted" {
			_, err := fmt.Fprintf(d.Out, "%s\tdeleted\n", output.EscapeTSVField(deletedID(doc)))
			return err
		}
		var r Report
		if json.Unmarshal(doc.Data, &r) == nil && r.ID != "" {
			_, err := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\t%s\t%s\n",
				output.EscapeTSVField(r.ID), output.EscapeTSVField(r.Type), stateWord(r),
				output.EscapeTSVField(r.CurrentStatus), output.EscapeTSVField(updated(r)), output.EscapeTSVField(r.Title))
			return err
		}
		_, err := fmt.Fprintln(d.Out, output.EscapeTSVField(string(doc.Data)))
		return err
	default:
		if doc.Kind == "StatusReportDeleted" {
			_, err := fmt.Fprintf(d.Out, "Deleted status report %s\n", output.SanitizeDisplay(deletedID(doc)))
			return err
		}
		var r Report
		if json.Unmarshal(doc.Data, &r) == nil && r.ID != "" {
			return renderReportDetail(d.Out, r)
		}
		_, err := fmt.Fprintln(d.Out, output.SanitizeDisplay(string(doc.Data)))
		return err
	}
}

func renderList(d Dependencies, format string, doc ListEnvelope) error {
	if handled, err := output.RenderStructuredList(d.Out, format, doc, doc.Data); handled {
		return err
	}
	switch format {
	case "tsv":
		for _, raw := range doc.Data {
			var r Report
			if json.Unmarshal(raw, &r) == nil {
				if _, err := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\t%s\t%s\n",
					output.EscapeTSVField(r.ID), output.EscapeTSVField(r.Type), stateWord(r),
					output.EscapeTSVField(r.CurrentStatus), output.EscapeTSVField(updated(r)), output.EscapeTSVField(r.Title)); err != nil {
					return err
				}
			}
		}
		return nil
	default:
		rows := make([][]string, 0, len(doc.Data))
		for _, raw := range doc.Data {
			var r Report
			if json.Unmarshal(raw, &r) == nil {
				rows = append(rows, []string{
					stateGlyph(r), output.SanitizeDisplay(r.Title), output.SanitizeDisplay(r.Type),
					output.SanitizeDisplay(r.CurrentStatus), output.SanitizeDisplay(updated(r))})
			}
		}
		if err := output.Table(d.Out, []string{"STATUS", "TITLE", "TYPE", "CURRENT", "UPDATED"}, rows); err != nil {
			return err
		}
		output.CursorHint(d.Err, "reports", doc.Meta.NextCursor)
		return nil
	}
}

func renderReportDetail(w io.Writer, r Report) error {
	fmt.Fprintf(w, "ID         %s\n", output.SanitizeDisplay(r.ID))
	fmt.Fprintf(w, "Title      %s\n", output.SanitizeDisplay(r.Title))
	fmt.Fprintf(w, "Type       %s\n", output.SanitizeDisplay(r.Type))
	fmt.Fprintf(w, "State      %s\n", stateGlyph(r))
	fmt.Fprintf(w, "Current    %s\n", output.SanitizeDisplay(dash(r.CurrentStatus)))
	fmt.Fprintf(w, "Starts     %s\n", output.SanitizeDisplay(dash(r.StartsAt)))
	if r.Type == "maintenance" || r.EndsAt != nil {
		fmt.Fprintf(w, "Ends       %s\n", output.SanitizeDisplay(pointer(r.EndsAt)))
	}
	fmt.Fprintf(w, "Published  %s\n", output.SanitizeDisplay(pointer(r.PublishedAt)))
	fmt.Fprintf(w, "Resolved   %s\n", output.SanitizeDisplay(pointer(r.ResolvedAt)))
	if r.OriginIncidentID != nil && *r.OriginIncidentID != "" {
		fmt.Fprintf(w, "Origin     %s\n", output.SanitizeDisplay(*r.OriginIncidentID))
	}
	if len(r.Affected) > 0 {
		fmt.Fprintln(w, "\nAffected:")
		rows := make([][]string, 0, len(r.Affected))
		for _, item := range r.Affected {
			// The two-space prefix on the first cell indents the whole
			// sub-table, tabwriter widens the column to absorb it.
			rows = append(rows, []string{
				"  " + output.SanitizeDisplay(item.MonitorID), output.SanitizeDisplay(item.MonitorName),
				output.SanitizeDisplay(pointer(item.GroupName)), output.SanitizeDisplay(item.Impact)})
		}
		if err := output.Table(w, []string{"  MONITOR", "NAME", "GROUP", "IMPACT"}, rows); err != nil {
			return err
		}
	}
	if len(r.Updates) > 0 {
		fmt.Fprintln(w, "\nUpdates:")
		for _, update := range r.Updates {
			fmt.Fprintf(w, "  %s  %s  (%s)\n", output.SanitizeDisplay(dash(update.PublishedAt)), output.SanitizeDisplay(update.Status), output.SanitizeDisplay(update.ID))
			for _, line := range strings.Split(strings.TrimRight(update.Markdown, "\n"), "\n") {
				fmt.Fprintf(w, "    %s\n", output.SanitizeDisplay(line))
			}
		}
	}
	return nil
}

func deletedID(doc Envelope) string {
	var deleted struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(doc.Data, &deleted)
	return dash(deleted.ID)
}

func stateGlyph(r Report) string {
	switch {
	case r.PublishedAt == nil:
		return "○ Draft"
	case r.ResolvedAt == nil:
		return "● Ongoing"
	default:
		return "✓ Resolved"
	}
}

func stateWord(r Report) string {
	switch {
	case r.PublishedAt == nil:
		return "draft"
	case r.ResolvedAt == nil:
		return "ongoing"
	default:
		return "resolved"
	}
}

func updated(r Report) string {
	if r.UpdatedAt != "" {
		return r.UpdatedAt
	}
	latest := ""
	for _, update := range r.Updates {
		if update.PublishedAt > latest {
			latest = update.PublishedAt
		}
	}
	return dash(latest)
}

func dash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func pointer(value *string) string {
	if value == nil || *value == "" {
		return "-"
	}
	return *value
}
