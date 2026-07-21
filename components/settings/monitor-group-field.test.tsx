// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MonitorGroupField } from "./monitor-group-field"

afterEach(cleanup)

const groups = [
  { id: "production", name: "Production", monitorCount: 1 },
  { id: "core", name: "Core", monitorCount: 2 },
]

describe("MonitorGroupField", () => {
  it("renders a create action instead of an empty select", () => {
    const onCreateGroup = vi.fn()
    render(
      <MonitorGroupField
        groups={[]}
        labelClassName="text-sm"
        onChange={vi.fn()}
        onCreateGroup={onCreateGroup}
        value={null}
      />
    )
    expect(screen.queryByRole("combobox", { name: "Group" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Create Group" }))
    expect(onCreateGroup).toHaveBeenCalledTimes(1)
  })

  it("lists existing groups through a labelled select", () => {
    render(
      <MonitorGroupField
        groups={groups}
        labelClassName="text-[13px]"
        onChange={vi.fn()}
        onCreateGroup={vi.fn()}
        value="production"
      />
    )
    expect(screen.getByRole("combobox", { name: "Group" })).toBeDefined()
    expect(screen.queryByRole("button", { name: "Create Group" })).toBeNull()
  })
})
