import { NotificationsSettings } from "@/components/settings/notifications-settings"
import { requireAdminSettings } from "@/lib/auth/require-admin"
import { getNotificationSettings } from "@/lib/reporting/queries/settings"

export default async function NotificationSettingsPage() {
  await requireAdminSettings()
  const data = await getNotificationSettings()

  return (
    <>
      <h1 className="mb-8 font-semibold text-xl tracking-[-0.02em]">
        Notifications
      </h1>
      <NotificationsSettings data={data} />
    </>
  )
}
