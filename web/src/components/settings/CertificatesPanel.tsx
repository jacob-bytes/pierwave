import { useState } from "react";
import {
  FileKeyIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { CertificateFormDialog } from "@/components/certificates/CertificateFormDialog";
import { DeleteCertificateDialog } from "@/components/certificates/DeleteCertificateDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Certificate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useCertificates } from "@/lib/queries";
import { formatAbsoluteTime, formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 5;

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-32" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-48" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-12" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="size-7 rounded-md" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function EmptyRow({ onUpload }: { onUpload: () => void }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <FileKeyIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("certificates.emptyTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("certificates.emptyDesc")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onUpload}>
            <PlusIcon className="size-3.5" />
            {t("certificates.emptyAction")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function ErrorRow({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlertIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("certificates.loadFailed")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCwIcon
              className={cn("size-3.5", retrying && "animate-spin")}
            />
            {t("common.retry")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** 剩余天数：<= 30 天走 warning，已过期走 destructive，文案固定为「已过期」。 */
function DaysLeft({ days }: { days: number }) {
  if (days < 0) {
    return (
      <span
        className="text-xs font-medium text-destructive"
        title={t("certificates.expiredTitle", { n: Math.abs(days) })}
      >
        {t("certificates.expired")}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        days <= 30 ? "text-warning" : "text-muted-foreground",
      )}
    >
      {t(days === 1 ? "certificates.daysLeftOne" : "certificates.daysLeft", {
        n: days,
      })}
    </span>
  );
}

function DomainsCell({ domains }: { domains: string[] }) {
  if (domains.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const label = domains.join(", ");
  return (
    <span
      className="block max-w-[260px] truncate text-xs text-muted-foreground"
      title={label}
    >
      {label}
    </span>
  );
}

/** 设置页的「证书」tab：列表 + 上传/删除对话框，四态齐全。 */
export function CertificatesPanel() {
  useI18n();
  const certificates = useCertificates();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Certificate | null>(null);

  const items = certificates.data ?? [];
  const showError = certificates.isError && !certificates.data;
  const errorMessage = errorText(
    certificates.error,
    t("certificates.loadError"),
  );

  return (
    <div className="space-y-6">
      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("certificates.list")}
              {certificates.data && !certificates.isError ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setUploadOpen(true)}>
                <PlusIcon className="size-3.5" />
                {t("certificates.upload")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void certificates.refetch()}
                disabled={certificates.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    certificates.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("certificates.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[820px]" aria-busy={certificates.isPending}>
            <TableCaption className="sr-only">{t("certificates.tableCaption")}</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("certificates.columns.name"),
                  t("certificates.columns.domains"),
                  t("certificates.columns.notAfter"),
                  t("certificates.columns.daysLeft"),
                  t("certificates.columns.actions"),
                ].map((label) => (
                  <TableHead
                    key={label}
                    className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground"
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {certificates.isPending ? (
                <LoadingRows />
              ) : showError ? (
                <ErrorRow
                  message={errorMessage}
                  retrying={certificates.isFetching}
                  onRetry={() => void certificates.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow onUpload={() => setUploadOpen(true)} />
              ) : (
                items.map((certificate) => (
                  <TableRow key={certificate.id}>
                    <TableCell className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <FileKeyIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{certificate.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <DomainsCell domains={certificate.domains} />
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                      <span title={formatAbsoluteTime(certificate.not_after)}>
                        {formatDate(certificate.not_after)}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <DaysLeft days={certificate.days_left} />
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t("common.delete")}
                        aria-label={t("certificates.deleteAria", {
                          name: certificate.name,
                        })}
                        onClick={() => setDeleteTarget(certificate)}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {uploadOpen ? (
        <CertificateFormDialog
          open
          onOpenChange={(open) => {
            if (!open) setUploadOpen(false);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteCertificateDialog
          key={deleteTarget.id}
          open
          certificate={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
