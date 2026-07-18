"use client";

import { useState } from "react";

import { MonitorSheet } from "@/components/settings/monitor-sheet";
import { Button } from "@/components/ui/button";

export function NewMonitorAction() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>New Monitor</Button>
      <MonitorSheet open={open} monitor={null} onClose={() => setOpen(false)} />
    </>
  );
}
