import type { ReactNode } from "react";

import styles from "@/components/status-page/status-page.module.css";

export default function PublicStatusLayout({ children }: { children: ReactNode }) {
  return <div className={styles.shell}>{children}</div>;
}
