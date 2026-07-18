import { NotificationsSettings } from "@/components/settings/notifications-settings";
import { getNotificationSettings } from "@/lib/reporting/queries/settings";

export default async function NotificationSettingsPage() {
  const data = await getNotificationSettings();

  return (
    <>
      <h1 className="mb-8 text-xl font-semibold tracking-[-0.02em]">Notifications</h1>
      <NotificationsSettings data={data} />
    </>
  );
}
