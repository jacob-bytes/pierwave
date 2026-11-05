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
  const createCertificate = useCreateCertificate();
  const pending = createCertificate.isPending;

  const form = useForm<CertificateFormValues>({
    resolver: zodResolver(certificateFormSchema),
    defaultValues: {
      name: "",
      cert_pem: "",
      key_pem: "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    try {
      const certificate = await createCertificate.mutateAsync({
        name: values.name,
        cert_pem: values.cert_pem,
        key_pem: values.key_pem,
      });
      toast.success(`证书「${certificate.name}」已上传`);
      onOpenChange(false);
    } catch (error) {
      // 解析失败、证书与私钥不匹配等都由后端判定，这里原样透出中文错误。
      const message = errorText(error, "上传证书失败，请稍后重试");
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
          <DialogTitle>上传证书</DialogTitle>
          <DialogDescription>
            粘贴证书与私钥的 PEM 内容；域名与有效期由后端解析，私钥上传后不再回显。
          </DialogDescription>
        </DialogHeader>

        <form id="certificate-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label="名称"
            htmlFor="certificate-name"
            required
            error={form.formState.errors.name?.message}
          >
            <Input
              id="certificate-name"
              autoComplete="off"
              placeholder="例如 example.com 泛域名"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register("name")}
            />
          </FormField>

          <FormField
            label="证书 PEM"
            htmlFor="certificate-cert-pem"
            required
            error={form.formState.errors.cert_pem?.message}
            hint="支持证书链；-----BEGIN CERTIFICATE----- 之后的内容原样提交。"
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
            label="私钥 PEM"
            htmlFor="certificate-key-pem"
            required
            error={form.formState.errors.key_pem?.message}
            hint="必须是未加密的私钥，且与上面的证书匹配。"
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
            取消
          </Button>
          <Button type="submit" form="certificate-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending ? "上传中…" : "上传证书"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
