export type CronJobName = "monitor-check" | "maintenance";
export type CronRunCounts = {
  monitorCount: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
};

export interface CronRunStore {
  start(input: { id: string; jobName: CronJobName; scheduledMinute: Date; startedAt: Date }): Promise<boolean>;
  complete(id: string, completedAt: Date, counts: CronRunCounts): Promise<void>;
  fail(id: string, completedAt: Date, errorMessage: string, counts?: CronRunCounts): Promise<void>;
}

export function emptyRunCounts(): CronRunCounts {
  return { monitorCount: 0, successCount: 0, failureCount: 0, skippedCount: 0 };
}

export function safeCronError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown cron failure";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}
