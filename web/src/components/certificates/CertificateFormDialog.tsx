import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/errors";
import { useCreateCertificate } from "@/lib/queries";
import {
  certificateFormSchema,
  type CertificateFormValues,
} from "@/lib/schemas";
import { t, useI18n } from "@/i18n";

interface CertificateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PEM_PLACEHOLDER = `-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----`;

const KEY_PLACEHOLDER = `-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----`;

export function CertificateFormDialog({
  open,
  onOpenChange,
}: CertificateFormDialogProps) {
  const { t: translate } = useI18n();
  const createCertificate = useCreateCertificate();
  const pending = createCertificate.isPending;

  const schema = useMemo(() => certificateFormSchema(translate), [translate]);
  const form = useForm<CertificateFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      cert_pem: "",
      key_pem: "",
    },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    try {
      const certificate = await createCertificate.mutateAsync({
        name: values.name,
        cert_pem: values.cert_pem,
        key_pem: values.key_pem,
      });
      toast.success(t("certificates.form.uploaded", { name: certificate.name }));
      onOpenChange(false);
    } catch (error) {
      // 解析失败、证书与私钥不匹配等都由后端判定，这里原样透出中文错误。
      const message = errorText(error, t("certificates.form.error"));
      form.setError("root", { message });
      toast.error(message);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("certificates.form.title")}</DialogTitle>
          <DialogDescription>
            {t("certificates.form.desc")}
          </DialogDescription>
        </DialogHeader>

        <form id="certificate-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label={t("certificates.form.name")}
            htmlFor="certificate-name"
            required
            error={form.formState.errors.name?.message}
          >
            <Input
              id="certificate-name"
              autoComplete="off"
              placeholder={t("certificates.form.namePlaceholder")}
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register("name")}
            />
          </FormField>

          <FormField
            label={t("certificates.form.certPem")}
            htmlFor="certificate-cert-pem"
            required
            error={form.formState.errors.cert_pem?.message}
            hint={t("certificates.form.certPemHint")}
          >
            <Textarea
              id="certificate-cert-pem"
              placeholder={PEM_PLACEHOLDER}
              spellCheck={false}
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.cert_pem)}
              className="min-h-36 resize-y font-mono text-xs leading-relaxed"
              {...form.register("cert_pem")}
            />
          </FormField>

          <FormField
            label={t("certificates.form.keyPem")}
            htmlFor="certificate-key-pem"
            required
            error={form.formState.errors.key_pem?.message}
            hint={t("certificates.form.keyPemHint")}
          >
            <Textarea
              id="certificate-key-pem"
              placeholder={KEY_PLACEHOLDER}
              spellCheck={false}
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.key_pem)}
              className="min-h-36 resize-y font-mono text-xs leading-relaxed"
              {...form.register("key_pem")}
            />
          </FormField>

          <FormRootError message={form.formState.errors.root?.message} />
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="certificate-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("certificates.form.submitting")
              : t("certificates.form.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
