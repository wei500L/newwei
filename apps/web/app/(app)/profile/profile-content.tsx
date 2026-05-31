"use client";

import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Divider,
  Form,
  Input,
  Spin,
  Typography,
  Upload,
  message,
} from "antd";
import type { UploadProps } from "antd";
import type { RcFile } from "antd/es/upload";
import type { AxiosResponse } from "axios";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AvatarFallback } from "@/components/avatar-fallback";
import { createApiClient } from "@/lib/api-client";
import type { AuthenticatedUser } from "@/lib/auth";
import { captureClientError } from "@/lib/client-telemetry";
import {
  downloadBlobFile,
  filenameFromContentDisposition,
  formatDateForFilename,
} from "@/lib/data-export";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_EMAIL_CODE_COOLDOWN_SECONDS = 90;

interface AvatarPresignResponse {
  uploadUrl: string;
  publicUrl: string;
  objectKey: string;
}

interface EmailCodeSendResponse {
  ok: boolean;
  cooldownSeconds?: number;
}

interface EmailBindingFormValues {
  email: string;
  code: string;
}

interface ProfileFormValues {
  firstName: string;
  lastName: string;
}

interface ChangePasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export function ProfileContent() {
  const { t } = useTranslation();
  const { data: session, status, update } = useSession();
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const [passwordForm] = Form.useForm<ChangePasswordFormValues>();
  const [emailForm] = Form.useForm<EmailBindingFormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const [uploading, setUploading] = useState(false);
  const [sendingEmailCode, setSendingEmailCode] = useState(false);
  const [verifyingEmail, setVerifyingEmail] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [exportingData, setExportingData] = useState(false);
  const [emailCodeCooldown, setEmailCodeCooldown] = useState(0);
  const [pendingEmailHint, setPendingEmailHint] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const user = session?.user;
  const displayName = [user?.firstName, user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const displayEmail = user?.email ?? "";
  const displayNameOrEmail =
    displayName || displayEmail || t("common.notAvailable");
  const showEmail = Boolean(displayEmail && displayName);
  const avatarSrc = user?.image ?? user?.avatarUrl ?? undefined;
  const currentPendingEmail = user?.pendingEmail ?? pendingEmailHint;

  useEffect(() => {
    if (!displayEmail) {
      return;
    }
    emailForm.setFieldsValue({ email: displayEmail });
  }, [displayEmail, emailForm]);

  useEffect(() => {
    profileForm.setFieldsValue({
      firstName: user?.firstName ?? "",
      lastName: user?.lastName ?? "",
    });
  }, [profileForm, user?.firstName, user?.lastName]);

  useEffect(() => {
    if (emailCodeCooldown <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setEmailCodeCooldown((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [emailCodeCooldown]);

  const beforeUpload = useCallback<NonNullable<UploadProps["beforeUpload"]>>(
    (file) => {
      if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
        messageApi.error(t("profile.avatar.errors.invalidType"));
        return Upload.LIST_IGNORE;
      }
      if (file.size > MAX_AVATAR_BYTES) {
        messageApi.error(t("profile.avatar.errors.tooLarge"));
        return Upload.LIST_IGNORE;
      }
      return true;
    },
    [messageApi, t],
  );

  const handleUpload = useCallback<NonNullable<UploadProps["customRequest"]>>(
    async ({ file, onError, onSuccess }) => {
      if (!(file instanceof File)) {
        const error = new Error("Invalid file object");
        messageApi.error(t("profile.avatar.errors.invalidFile"));
        onError?.(error);
        return;
      }

      setUploading(true);
      try {
        const presignResponse = await apiClient.post<AvatarPresignResponse>(
          "auth/avatar/presigned-url",
          {
            contentType: file.type,
            contentLength: file.size,
          },
        );

        const uploadResponse = await fetch(presignResponse.data.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": file.type,
          },
          body: file,
        });

        if (!uploadResponse.ok) {
          throw new Error(`Upload failed with status ${uploadResponse.status}`);
        }

        const profileResponse = await apiClient.patch<AuthenticatedUser>(
          "auth/profile",
          {
            avatarUrl: presignResponse.data.publicUrl,
          },
        );

        await update({ user: profileResponse.data });
        messageApi.success(t("profile.avatar.success"));
        onSuccess?.({}, file as RcFile);
      } catch (error) {
        captureClientError("Avatar upload failed", error);
        messageApi.error(t("profile.avatar.errors.uploadFailed"));
        onError?.(error as Error);
      } finally {
        setUploading(false);
      }
    },
    [apiClient, messageApi, t, update],
  );

  const handleSendVerificationCode = useCallback(async () => {
    try {
      const values = await emailForm.validateFields(["email"]);
      setSendingEmailCode(true);
      const response = await apiClient.post<EmailCodeSendResponse>(
        "auth/send-verification",
        {
          email: values.email,
        },
      );
      const cooldownSeconds =
        response.data.cooldownSeconds ?? DEFAULT_EMAIL_CODE_COOLDOWN_SECONDS;
      setEmailCodeCooldown(cooldownSeconds);
      setPendingEmailHint(values.email.trim().toLowerCase());
      messageApi.success(t("profile.emailBinding.sendSuccess"));
    } catch (error) {
      const validationError =
        typeof error === "object" &&
        error !== null &&
        "errorFields" in error &&
        Array.isArray((error as { errorFields?: unknown }).errorFields);
      if (validationError) {
        return;
      }
      captureClientError("Failed to send email verification code", error);
      messageApi.error(t("profile.emailBinding.sendFailed"));
    } finally {
      setSendingEmailCode(false);
    }
  }, [apiClient, emailForm, messageApi, t]);

  const handleVerifyEmail = useCallback(async () => {
    try {
      const values = await emailForm.validateFields(["code"]);
      setVerifyingEmail(true);
      const response = await apiClient.post<AuthenticatedUser>(
        "auth/verify-email",
        {
          code: values.code,
        },
      );
      await update({ user: response.data });
      setPendingEmailHint(null);
      setEmailCodeCooldown(0);
      emailForm.setFieldsValue({ email: response.data.email, code: "" });
      messageApi.success(t("profile.emailBinding.verifySuccess"));
    } catch (error) {
      const validationError =
        typeof error === "object" &&
        error !== null &&
        "errorFields" in error &&
        Array.isArray((error as { errorFields?: unknown }).errorFields);
      if (validationError) {
        return;
      }
      captureClientError("Failed to verify email", error);
      messageApi.error(t("profile.emailBinding.verifyFailed"));
    } finally {
      setVerifyingEmail(false);
    }
  }, [apiClient, emailForm, messageApi, t, update]);

  const handleSaveProfile = useCallback(async () => {
    try {
      const values = await profileForm.validateFields();
      setSavingProfile(true);
      const response = await apiClient.patch<AuthenticatedUser>("auth/profile", {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
      });
      await update({ user: response.data });
      messageApi.success(
        t("profile.details.success", {
          defaultValue: "Profile updated.",
        }),
      );
    } catch (error) {
      const validationError =
        typeof error === "object" &&
        error !== null &&
        "errorFields" in error &&
        Array.isArray((error as { errorFields?: unknown }).errorFields);
      if (validationError) {
        return;
      }
      captureClientError("Failed to update profile details", error);
      messageApi.error(
        t("profile.details.failed", {
          defaultValue: "Failed to update profile.",
        }),
      );
    } finally {
      setSavingProfile(false);
    }
  }, [apiClient, messageApi, profileForm, t, update]);

  const handleChangePassword = useCallback(async () => {
    try {
      const values = await passwordForm.validateFields();
      setChangingPassword(true);
      await apiClient.post("auth/change-password", {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      passwordForm.resetFields();
      messageApi.success(
        t("profile.password.success", {
          defaultValue: "Password changed. Please use the new password next time you sign in.",
        }),
      );
    } catch (error) {
      const validationError =
        typeof error === "object" &&
        error !== null &&
        "errorFields" in error &&
        Array.isArray((error as { errorFields?: unknown }).errorFields);
      if (validationError) {
        return;
      }
      captureClientError("Failed to change password", error);
      messageApi.error(
        t("profile.password.failed", {
          defaultValue: "Failed to change password.",
        }),
      );
    } finally {
      setChangingPassword(false);
    }
  }, [apiClient, messageApi, passwordForm, t]);

  const handleExportUserData = useCallback(async () => {
    try {
      setExportingData(true);
      const response = await apiClient.get<Blob, AxiosResponse<Blob>>(
        "auth/data-export",
        { responseType: "blob" },
      );
      const rawContentDisposition = response.headers?.["content-disposition"];
      const contentDisposition = Array.isArray(rawContentDisposition)
        ? rawContentDisposition.join("; ")
        : rawContentDisposition;
      const fallbackFilename = `wei-user-data-${formatDateForFilename(new Date())}.json`;
      downloadBlobFile(
        response.data,
        filenameFromContentDisposition(contentDisposition) ?? fallbackFilename,
      );
      messageApi.success(
        t("profile.dataExport.success", {
          defaultValue: "Data export downloaded.",
        }),
      );
    } catch (error) {
      captureClientError("Failed to export user data", error);
      messageApi.error(
        t("profile.dataExport.failed", {
          defaultValue: "Failed to download data export.",
        }),
      );
    } finally {
      setExportingData(false);
    }
  }, [apiClient, messageApi, t]);

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (status !== "authenticated") {
    return null;
  }

  return (
    <Card className="content-card" title={t("profile.title")}>
      {contextHolder}
      <Typography.Paragraph type="secondary">
        {t("profile.description")}
      </Typography.Paragraph>
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <AvatarFallback
            size={72}
            src={avatarSrc}
            name={displayName}
            email={displayEmail}
            className="bg-blue-500"
          />
          <div className="min-w-0">
            <Typography.Text strong>{displayNameOrEmail}</Typography.Text>
            {showEmail ? (
              <div className="text-xs text-gray-500 truncate">
                {displayEmail}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Typography.Text strong>{t("profile.avatar.title")}</Typography.Text>
          <Typography.Paragraph type="secondary">
            {t("profile.avatar.description")}
          </Typography.Paragraph>
          <Upload
            accept="image/jpeg,image/png,image/webp"
            showUploadList={false}
            beforeUpload={beforeUpload}
            customRequest={handleUpload}
            maxCount={1}
            disabled={uploading}
          >
            <Button
              type="primary"
              icon={<UploadOutlined />}
              loading={uploading}
            >
              {uploading
                ? t("profile.avatar.uploading")
                : t("profile.avatar.upload")}
            </Button>
          </Upload>
          <Typography.Text type="secondary">
            {t("profile.avatar.requirements")}
          </Typography.Text>
        </div>
        <Divider style={{ margin: 0 }} />
        <div className="flex flex-col gap-2">
          <Typography.Text strong>
            {t("profile.details.title", { defaultValue: "Profile details" })}
          </Typography.Text>
          <Typography.Paragraph type="secondary">
            {t("profile.details.description", {
              defaultValue:
                "Update how your name appears across saved views, comments, and collaboration surfaces.",
            })}
          </Typography.Paragraph>
          <Form form={profileForm} layout="vertical">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Form.Item
                label={t("profile.details.firstName", {
                  defaultValue: "First name",
                })}
                name="firstName"
                rules={[
                  {
                    required: true,
                    message: t("profile.details.firstNameRequired", {
                      defaultValue: "Enter a first name.",
                    }),
                  },
                ]}
              >
                <Input maxLength={80} autoComplete="given-name" size="large" />
              </Form.Item>
              <Form.Item
                label={t("profile.details.lastName", {
                  defaultValue: "Last name",
                })}
                name="lastName"
                rules={[
                  {
                    required: true,
                    message: t("profile.details.lastNameRequired", {
                      defaultValue: "Enter a last name.",
                    }),
                  },
                ]}
              >
                <Input maxLength={80} autoComplete="family-name" size="large" />
              </Form.Item>
            </div>
            <Button
              type="primary"
              onClick={() => void handleSaveProfile()}
              loading={savingProfile}
            >
              {t("profile.details.save", { defaultValue: "Save profile" })}
            </Button>
          </Form>
        </div>
        <Divider style={{ margin: 0 }} />
        <div className="flex flex-col gap-2">
          <Typography.Text strong>
            {t("profile.password.title", { defaultValue: "Change password" })}
          </Typography.Text>
          <Typography.Paragraph type="secondary">
            {t("profile.password.description", {
              defaultValue:
                "Changing your password revokes existing refresh tokens and secures future sessions.",
            })}
          </Typography.Paragraph>
          <Form form={passwordForm} layout="vertical">
            <Form.Item
              label={t("profile.password.current", {
                defaultValue: "Current password",
              })}
              name="currentPassword"
              rules={[
                {
                  required: true,
                  message: t("profile.password.currentRequired", {
                    defaultValue: "Enter your current password.",
                  }),
                },
              ]}
            >
              <Input.Password autoComplete="current-password" size="large" />
            </Form.Item>
            <Form.Item
              label={t("profile.password.new", { defaultValue: "New password" })}
              name="newPassword"
              rules={[
                {
                  required: true,
                  message: t("profile.password.newRequired", {
                    defaultValue: "Enter a new password.",
                  }),
                },
                {
                  min: 8,
                  message: t("profile.password.newMin", {
                    defaultValue: "Password must be at least 8 characters.",
                  }),
                },
              ]}
            >
              <Input.Password autoComplete="new-password" size="large" />
            </Form.Item>
            <Form.Item
              label={t("profile.password.confirm", {
                defaultValue: "Confirm new password",
              })}
              name="confirmPassword"
              dependencies={["newPassword"]}
              rules={[
                {
                  required: true,
                  message: t("profile.password.confirmRequired", {
                    defaultValue: "Confirm the new password.",
                  }),
                },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue("newPassword") === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(
                      new Error(
                        t("profile.password.confirmMismatch", {
                          defaultValue: "Passwords do not match.",
                        }),
                      ),
                    );
                  },
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" size="large" />
            </Form.Item>
            <Button
              type="primary"
              onClick={() => void handleChangePassword()}
              loading={changingPassword}
            >
              {t("profile.password.submit", {
                defaultValue: "Change password",
              })}
            </Button>
          </Form>
        </div>
        <Divider style={{ margin: 0 }} />
        <div className="flex flex-col gap-2">
          <Typography.Text strong>
            {t("profile.dataExport.title", {
              defaultValue: "Data export",
            })}
          </Typography.Text>
          <Typography.Paragraph type="secondary">
            {t("profile.dataExport.description", {
              defaultValue:
                "Download a machine-readable JSON copy of your account, settings, subscriptions, personalization, saved analysis, notifications, and assistant records for this organization.",
            })}
          </Typography.Paragraph>
          <Button
            icon={<DownloadOutlined />}
            onClick={() => void handleExportUserData()}
            loading={exportingData}
          >
            {t("profile.dataExport.download", {
              defaultValue: "Download data export",
            })}
          </Button>
        </div>
        <Divider style={{ margin: 0 }} />
        <div className="flex flex-col gap-2">
          <Typography.Text strong>
            {t("profile.emailBinding.title")}
          </Typography.Text>
          <Typography.Paragraph type="secondary">
            {t("profile.emailBinding.description")}
          </Typography.Paragraph>
          <Typography.Text>
            {t("profile.emailBinding.currentEmail", {
              email: displayEmail || t("common.notAvailable"),
            })}
          </Typography.Text>
          <Typography.Text type={user?.emailVerified ? "success" : "warning"}>
            {user?.emailVerified
              ? t("profile.emailBinding.statusVerified")
              : t("profile.emailBinding.statusUnverified")}
          </Typography.Text>
          {currentPendingEmail ? (
            <Alert
              type="info"
              showIcon
              message={t("profile.emailBinding.pendingEmail", {
                email: currentPendingEmail,
              })}
            />
          ) : null}
          <Form form={emailForm} layout="vertical">
            <Form.Item
              label={t("profile.emailBinding.fields.email.label")}
              name="email"
              rules={[
                {
                  required: true,
                  message: t("profile.emailBinding.fields.email.required"),
                },
                {
                  type: "email",
                  message: t("profile.emailBinding.fields.email.invalid"),
                },
              ]}
            >
              <Input
                placeholder={t("profile.emailBinding.fields.email.placeholder")}
                autoComplete="email"
                size="large"
              />
            </Form.Item>
            <Form.Item>
              <Button
                onClick={handleSendVerificationCode}
                disabled={sendingEmailCode || emailCodeCooldown > 0}
                loading={sendingEmailCode}
              >
                {emailCodeCooldown > 0
                  ? t("profile.emailBinding.sendCodeCooldown", {
                      seconds: emailCodeCooldown,
                    })
                  : t("profile.emailBinding.sendCode")}
              </Button>
            </Form.Item>
            <Form.Item
              label={t("profile.emailBinding.fields.code.label")}
              name="code"
              rules={[
                {
                  required: true,
                  message: t("profile.emailBinding.fields.code.required"),
                },
                {
                  pattern: /^\d{8}$/,
                  message: t("profile.emailBinding.fields.code.invalid"),
                },
              ]}
            >
              <Input
                placeholder={t("profile.emailBinding.fields.code.placeholder")}
                inputMode="numeric"
                maxLength={8}
                size="large"
              />
            </Form.Item>
            <Button
              type="primary"
              onClick={handleVerifyEmail}
              loading={verifyingEmail}
              disabled={verifyingEmail}
            >
              {t("profile.emailBinding.verify")}
            </Button>
          </Form>
        </div>
      </div>
    </Card>
  );
}
