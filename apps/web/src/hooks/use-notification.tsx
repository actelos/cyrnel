import { type ExternalToast, toast } from "sonner";

type NotificationType = "success" | "error";

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
    if (n.type === "error") {
      toast.error(n.title, options);
    } else {
      toast.success(n.title, options);
    }
  };

  const dismissNotification = () => {
    toast.dismiss();
  };

  return { addNotification, dismissNotification };
}
