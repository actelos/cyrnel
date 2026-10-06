import { type ExternalToast, toast } from "sonner";

type NotificationType = "success" | "info" | "warning" | "error";

type Notification = {
  type: NotificationType;
  title: string;
  message: string;
};

type NotificationContextValue = {
  addNotification: (n: Notification) => void;
  dismissNotification: () => void;
};

export function NotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

export function useNotification(): NotificationContextValue {
  const addNotification = (n: Notification) => {
    const options: ExternalToast = { description: n.message };
    switch (n.type) {
      case "error":
        toast.error(n.title, options);
        break;
      case "warning":
        toast.warning(n.title, options);
        break;
      case "info":
        toast.info(n.title, options);
        break;
      default:
        toast.success(n.title, options);
        break;
    }
  };

  const dismissNotification = () => {
    toast.dismiss();
  };

  return { addNotification, dismissNotification };
}
