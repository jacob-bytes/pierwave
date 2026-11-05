/** 四态色板：active=primary / expired=warning / exhausted=destructive / disabled=muted。 */
export const statusToneClasses = {
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
} as const;

export type PackageStatusTone = keyof typeof statusToneClasses;
