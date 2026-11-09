import { toast } from "sonner";
import { CopyIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/clipboard";
import { t } from "@/i18n";

interface SubscriptionQrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  username: string;
  url: string;
}

/**
 * 订阅二维码：深色界面里保持白底黑码，纠错级别 Q（25%），
 * 四周留 4 个模块的静区，保证手机在暗色背景下也能扫。
 */
export function SubscriptionQrDialog({
  open,
  onOpenChange,
  username,
  url,
}: SubscriptionQrDialogProps) {
  async function handleCopy() {
    if (await copyText(url)) {
      toast.success(t("subscriptions.qr.copied"));
    } else {
      toast.error(t("subscriptions.qr.copyError"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("subscriptions.qr.title")}</DialogTitle>
          <DialogDescription>
            {t("subscriptions.qr.desc", { username })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3">
          <div className="rounded-lg bg-qr p-3 ring-1 ring-border">
            <QRCodeSVG
              value={url}
              size={208}
              level="Q"
              marginSize={4}
              bgColor="var(--qr-background)"
              fgColor="var(--qr-foreground)"
              title={t("subscriptions.qr.imageTitle", { username })}
            />
          </div>
          <code
            className="w-full truncate rounded-md bg-muted px-2 py-1.5 text-center font-mono text-micro text-muted-foreground"
            title={url}
          >
            {url}
          </code>
        </div>

        <DialogFooter showCloseButton>
          <Button variant="outline" onClick={() => void handleCopy()}>
            <CopyIcon className="size-3.5" />
            {t("subscriptions.qr.copyLink")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
