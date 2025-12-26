"use client";

import { UploadOutlined } from "@ant-design/icons";
import { Button, Card, Spin, Typography, Upload, message } from "antd";
import type { UploadProps } from "antd";
import type { RcFile } from "antd/es/upload";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AvatarFallback } from "@/components/avatar-fallback";
import type { AuthenticatedUser } from "@/lib/auth";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface AvatarPresignResponse {
  uploadUrl: string;
  publicUrl: string;
  objectKey: string;
}

export function ProfileContent() {
  const { t } = useTranslation();
  const { data: session, status, update } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [uploading, setUploading] = useState(false);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const user = session?.user;
  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const displayEmail = user?.email ?? "";
  const displayNameOrEmail = displayName || displayEmail || t("common.notAvailable");
  const showEmail = Boolean(displayEmail && displayName);
  const avatarSrc = user?.image ?? user?.avatarUrl ?? undefined;

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
    [messageApi, t]
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
        const presignResponse = await apiClient.post<AvatarPresignResponse>("auth/avatar/presigned-url", {
          contentType: file.type,
          contentLength: file.size
        });

        const uploadResponse = await fetch(presignResponse.data.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": file.type
          },
          body: file
        });

        if (!uploadResponse.ok) {
          throw new Error(`Upload failed with status ${uploadResponse.status}`);
        }

        const profileResponse = await apiClient.patch<AuthenticatedUser>("auth/profile", {
          avatarUrl: presignResponse.data.publicUrl
        });

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
    [apiClient, messageApi, t, update]
  );

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
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
      <Typography.Paragraph type="secondary">{t("profile.description")}</Typography.Paragraph>
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
              <div className="text-xs text-gray-500 truncate">{displayEmail}</div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Typography.Text strong>{t("profile.avatar.title")}</Typography.Text>
          <Typography.Paragraph type="secondary">{t("profile.avatar.description")}</Typography.Paragraph>
          <Upload
            accept="image/jpeg,image/png,image/webp"
            showUploadList={false}
            beforeUpload={beforeUpload}
            customRequest={handleUpload}
            maxCount={1}
            disabled={uploading}
          >
            <Button type="primary" icon={<UploadOutlined />} loading={uploading}>
              {uploading ? t("profile.avatar.uploading") : t("profile.avatar.upload")}
            </Button>
          </Upload>
          <Typography.Text type="secondary">{t("profile.avatar.requirements")}</Typography.Text>
        </div>
      </div>
    </Card>
  );
}
