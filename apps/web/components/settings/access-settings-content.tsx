'use client';

import { gql, useApolloClient, useLazyQuery, useMutation, useQuery } from '@apollo/client';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  List,
  message,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  canViewLoginHistory,
  getAssignableRoles,
  getPermissionPreview,
  getReadOnlyReason,
  getSystemAdminRoleIds,
  getUserDisplayName,
  getUserRoleNames,
  isOrgAdminSession,
  normalizeRoleSelection,
} from '@/lib/access-settings';
import {
  buildAdminSettingsPanelSelectionHref,
  getAdminSettingsPanelDescriptionKey,
} from '@/lib/admin-settings-panel-links';
import { captureClientError } from '@/lib/client-telemetry';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

interface PermissionListItem {
  id: string;
  name: string;
  description?: string | null;
}

interface RoleListItem {
  id: string;
  name: string;
  description?: string | null;
  isSystem: boolean;
  permissions: PermissionListItem[];
}

interface UserListItem {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  primaryRoleId?: string | null;
  isActive: boolean;
  emailVerified?: string | null;
  lastLoginAt?: string | null;
  roleIds: string[];
  permissions: string[];
}

interface UserLoginRecordListItem {
  id: string;
  createdAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  method: string;
}

interface AccessSettingsMetaData {
  roles: RoleListItem[];
  permissions: PermissionListItem[];
}

interface AccessSettingsUsersData {
  users: UserListItem[];
}

interface CreateRoleInput {
  name: string;
  description?: string;
  permissions: string[];
}

interface UpdateRoleInput {
  id: string;
  description?: string;
  permissions: string[];
}

interface UpdateMembershipRolesInput {
  userId: string;
  primaryRoleId: string;
  roleIds: string[];
}

interface SetUserActiveInput {
  userId: string;
  isActive: boolean;
}

interface CreateRoleMutationData {
  createRole: RoleListItem;
}

interface UpdateRoleMutationData {
  updateRole: RoleListItem;
}

interface UpdateMembershipRolesMutationData {
  updateMembershipRoles: UserListItem;
}

interface SetUserActiveMutationData {
  setUserActive: UserListItem;
}

interface UserLoginRecordsData {
  userLoginRecords: UserLoginRecordListItem[];
}

interface AccessSettingsUsersVariables {
  first: number;
  after?: string;
  search?: string;
}

interface UserLoginRecordsVariables {
  userId: string;
  limit?: number;
}

type RoleFormValues = Omit<UpdateRoleInput, 'id'>;
type CreateRoleFormValues = CreateRoleInput;
type UserStatusFilter = 'all' | 'active' | 'inactive';

const USERS_PAGE_SIZE = 200;
const LOGIN_RECORD_LIMIT = 20;

const ACCESS_SETTINGS_META_QUERY = gql`
  query AccessSettingsMetaRuntime {
    roles(includeSystem: true) {
      id
      name
      description
      isSystem
      permissions {
        id
        name
        description
      }
    }
    permissions {
      id
      name
      description
    }
  }
`;

const ACCESS_SETTINGS_USERS_QUERY = gql`
  query AccessSettingsUsersRuntime($first: Int!, $after: String, $search: String) {
    users(first: $first, after: $after, search: $search) {
      id
      email
      firstName
      lastName
      primaryRoleId
      isActive
      emailVerified
      lastLoginAt
      roleIds
      permissions
    }
  }
`;

const CREATE_ROLE_MUTATION = gql`
  mutation CreateRoleRuntime($input: CreateRoleInput!) {
    createRole(input: $input) {
      id
      name
      description
      isSystem
      permissions {
        id
        name
        description
      }
    }
  }
`;

const UPDATE_ROLE_MUTATION = gql`
  mutation UpdateRoleRuntime($input: UpdateRoleInput!) {
    updateRole(input: $input) {
      id
      name
      description
      isSystem
      permissions {
        id
        name
        description
      }
    }
  }
`;

const UPDATE_MEMBERSHIP_ROLES_MUTATION = gql`
  mutation UpdateMembershipRolesRuntime($input: UpdateMembershipRolesInput!) {
    updateMembershipRoles(input: $input) {
      id
      email
      firstName
      lastName
      primaryRoleId
      isActive
      emailVerified
      lastLoginAt
      roleIds
      permissions
    }
  }
`;

const SET_USER_ACTIVE_MUTATION = gql`
  mutation SetUserActiveRuntime($input: SetUserActiveInput!) {
    setUserActive(input: $input) {
      id
      email
      firstName
      lastName
      primaryRoleId
      isActive
      emailVerified
      lastLoginAt
      roleIds
      permissions
    }
  }
`;

const USER_LOGIN_RECORDS_QUERY = gql`
  query UserLoginRecordsRuntime($userId: String!, $limit: Int) {
    userLoginRecords(userId: $userId, limit: $limit) {
      id
      createdAt
      ipAddress
      userAgent
      method
    }
  }
`;

function haveSameItems(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftValues = [...left].sort();
  const rightValues = [...right].sort();
  return leftValues.every((value, index) => value === rightValues[index]);
}

function encodeCursor(value: string): string {
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return window.btoa(value);
  }

  return Buffer.from(value, 'utf8').toString('base64');
}

function normalizeOptionalText(value?: string | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getLoginMethodLabel(
  method: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const normalized = method.trim().toLowerCase();
  if (normalized === 'password') {
    return t('settings.members.loginMethods.password');
  }
  if (normalized === 'email_code') {
    return t('settings.members.loginMethods.emailCode');
  }
  return t('settings.members.loginMethods.other');
}

function formatOptionalDateTime(
  value: string | null | undefined,
  locale: ReturnType<typeof resolveLocale>,
): string | null {
  if (!value) {
    return null;
  }

  return formatDateTime(value, locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function AccessSettingsContent() {
  const { t, i18n } = useTranslation();
  const apolloClient = useApolloClient();
  const locale = resolveLocale(i18n.language);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const [messageApi, messageContext] = message.useMessage();
  const [userSearch, setUserSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>('all');
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [statusUserId, setStatusUserId] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [loginTarget, setLoginTarget] = useState<UserListItem | null>(null);
  const [loginRecordsUserId, setLoginRecordsUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<Error | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const usersRequestIdRef = useRef(0);

  const sessionPermissions = session?.permissions ?? [];
  const canViewSettings = sessionPermissions.includes('settings.manage');
  const canReadAccessMetadata =
    canViewSettings &&
    sessionPermissions.includes('roles.read') &&
    sessionPermissions.includes('permissions.read');
  const currentUserId = session?.user?.id ?? null;
  const deferredUserSearch = useDeferredValue(userSearch.trim());

  const {
    data: metaData,
    loading: metaLoading,
    error: metaError,
    refetch: refetchMeta,
  } = useQuery<AccessSettingsMetaData>(ACCESS_SETTINGS_META_QUERY, {
    skip: !canReadAccessMetadata,
    fetchPolicy: 'cache-and-network',
  });
  const [createRoleMutation, { loading: creatingRole }] = useMutation<
    CreateRoleMutationData,
    { input: CreateRoleInput }
  >(CREATE_ROLE_MUTATION);
  const [updateRoleMutation, { loading: updatingRole }] = useMutation<
    UpdateRoleMutationData,
    { input: UpdateRoleInput }
  >(UPDATE_ROLE_MUTATION);
  const [updateMembershipRolesMutation, { loading: savingUserAccess }] =
    useMutation<
      UpdateMembershipRolesMutationData,
      { input: UpdateMembershipRolesInput }
    >(UPDATE_MEMBERSHIP_ROLES_MUTATION);
  const [setUserActiveMutation] = useMutation<
    SetUserActiveMutationData,
    { input: SetUserActiveInput }
  >(SET_USER_ACTIVE_MUTATION);
  const [
    loadLoginRecords,
    { data: loginRecordsData, loading: loginRecordsLoading, error: loginRecordsError },
  ] = useLazyQuery<UserLoginRecordsData, UserLoginRecordsVariables>(
    USER_LOGIN_RECORDS_QUERY,
    {
      fetchPolicy: 'network-only',
    },
  );

  const roles = metaData?.roles ?? [];
  const permissions = metaData?.permissions ?? [];
  const adminRoleIds = useMemo(() => getSystemAdminRoleIds(roles), [roles]);
  const isOrgAdmin =
    canReadAccessMetadata &&
    isOrgAdminSession(session?.user?.roleIds ?? [], adminRoleIds);

  async function loadAllUsers(search: string | undefined) {
    if (!canReadAccessMetadata || !isOrgAdmin) {
      usersRequestIdRef.current += 1;
      setUsers([]);
      setUsersError(null);
      setUsersLoading(false);
      return;
    }

    const requestId = usersRequestIdRef.current + 1;
    usersRequestIdRef.current = requestId;
    setUsersError(null);
    setUsersLoading(true);

    try {
      const collectedUsers: UserListItem[] = [];
      let after: string | undefined;

      for (;;) {
        const result = await apolloClient.query<
          AccessSettingsUsersData,
          AccessSettingsUsersVariables
        >({
          query: ACCESS_SETTINGS_USERS_QUERY,
          variables: {
            first: USERS_PAGE_SIZE,
            after,
            search,
          },
          fetchPolicy: 'network-only',
        });
        const page = result.data.users ?? [];
        collectedUsers.push(...page);

        if (page.length < USERS_PAGE_SIZE) {
          break;
        }

        const lastUser = page[page.length - 1];
        if (!lastUser) {
          break;
        }

        after = encodeCursor(lastUser.id);
      }

      if (usersRequestIdRef.current !== requestId) {
        return;
      }

      setUsers(collectedUsers);
    } catch (queryError) {
      if (usersRequestIdRef.current !== requestId) {
        return;
      }

      captureClientError('Failed to load access settings users', queryError);
      setUsers([]);
      setUsersError(new Error(t('settings.members.loadFailed')));
    } finally {
      if (usersRequestIdRef.current === requestId) {
        setUsersLoading(false);
      }
    }
  }

  const filteredUsers = useMemo(() => {
    return [...users]
      .filter((user) => {
        if (statusFilter === 'active') {
          return user.isActive;
        }
        if (statusFilter === 'inactive') {
          return !user.isActive;
        }
        return true;
      })
      .sort((left, right) => {
        const leftReadOnly = getReadOnlyReason(left, adminRoleIds, currentUserId);
        const rightReadOnly = getReadOnlyReason(right, adminRoleIds, currentUserId);
        if (leftReadOnly !== rightReadOnly) {
          return Number(Boolean(rightReadOnly)) - Number(Boolean(leftReadOnly));
        }

        const rightLastLogin = right.lastLoginAt
          ? new Date(right.lastLoginAt).valueOf()
          : Number.NEGATIVE_INFINITY;
        const leftLastLogin = left.lastLoginAt
          ? new Date(left.lastLoginAt).valueOf()
          : Number.NEGATIVE_INFINITY;
        if (rightLastLogin !== leftLastLogin) {
          return rightLastLogin - leftLastLogin;
        }

        return getUserDisplayName(left).localeCompare(getUserDisplayName(right));
      });
  }, [adminRoleIds, currentUserId, statusFilter, users]);

  useEffect(() => {
    if (!loginTarget) {
      return;
    }

    setLoginRecordsUserId(loginTarget.id);
    void loadLoginRecords({
      variables: {
        userId: loginTarget.id,
        limit: LOGIN_RECORD_LIMIT,
      },
    });
  }, [loadLoginRecords, loginTarget]);

  useEffect(() => {
    if (metaError) {
      captureClientError('Failed to load access settings overview', metaError);
    }
  }, [metaError]);

  useEffect(() => {
    void loadAllUsers(deferredUserSearch || undefined);
  }, [deferredUserSearch, isOrgAdmin, canReadAccessMetadata]);

  useEffect(() => {
    if (loginRecordsError) {
      captureClientError('Failed to load user login records', loginRecordsError);
    }
  }, [loginRecordsError]);

  const selectedPanel = (() => {
    const candidate = searchParams.get('panel');
    const validPanels = ['roles', 'permissions', 'members'];
    return validPanels.includes(candidate ?? '') ? candidate : null;
  })();

  useEffect(() => {
    if (!selectedPanel) {
      return;
    }

    const target = sectionRefs.current[selectedPanel];
    if (!target) {
      return;
    }

    const timer = window.setTimeout(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 40);

    return () => window.clearTimeout(timer);
  }, [selectedPanel]);

  const handleSectionSelect = (key: string) => {
    router.replace(
      buildAdminSettingsPanelSelectionHref(pathname, searchParams, key),
    );
  };

  const handleCreateRole = async (values: CreateRoleFormValues) => {
    try {
      await createRoleMutation({
        variables: {
          input: {
            name: values.name.trim(),
            description: normalizeOptionalText(values.description),
            permissions: values.permissions,
          },
        },
      });
      await refetchMeta();
      messageApi.success(t('settings.roles.created'));
    } catch (mutationError) {
      captureClientError('Failed to create role', mutationError);
      messageApi.error(t('settings.roles.createFailed'));
      throw mutationError;
    }
  };

  const handleRoleSave = async (roleId: string, values: RoleFormValues) => {
    setSavingRoleId(roleId);

    try {
      await updateRoleMutation({
        variables: {
          input: {
            id: roleId,
            description: normalizeOptionalText(values.description),
            permissions: values.permissions,
          },
        },
      });
      await refetchMeta();
      messageApi.success(t('settings.roles.updated'));
    } catch (mutationError) {
      captureClientError('Failed to update role', mutationError);
      messageApi.error(t('settings.roles.updateFailed'));
    } finally {
      setSavingRoleId(null);
    }
  };

  const handleUserAccessSave = async (
    user: UserListItem,
    primaryRoleId: string,
    roleIds: string[],
  ) => {
    try {
      await updateMembershipRolesMutation({
        variables: {
          input: {
            userId: user.id,
            primaryRoleId,
            roleIds: normalizeRoleSelection(primaryRoleId, roleIds),
          },
        },
      });
      await loadAllUsers(deferredUserSearch || undefined);
      setEditingUser(null);
      messageApi.success(t('settings.members.updated'));
    } catch (mutationError) {
      captureClientError('Failed to update user access', mutationError);
      messageApi.error(t('settings.members.updateFailed'));
      throw mutationError;
    }
  };

  const handleUserStatusChange = (user: UserListItem, nextIsActive: boolean) => {
    Modal.confirm({
      title: nextIsActive
        ? t('settings.members.confirmEnableTitle')
        : t('settings.members.confirmDisableTitle'),
      content: nextIsActive
        ? t('settings.members.confirmEnableDescription', {
            name: getUserDisplayName(user),
          })
        : t('settings.members.confirmDisableDescription', {
            name: getUserDisplayName(user),
          }),
      okText: nextIsActive ? t('common.enable') : t('common.disable'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: !nextIsActive },
      onOk: async () => {
        setStatusUserId(user.id);

        try {
          await setUserActiveMutation({
            variables: {
              input: {
                userId: user.id,
                isActive: nextIsActive,
              },
            },
          });
          await loadAllUsers(deferredUserSearch || undefined);
          messageApi.success(
            nextIsActive
              ? t('settings.members.enabled')
              : t('settings.members.disabled'),
          );
        } catch (mutationError) {
          captureClientError('Failed to update user status', mutationError);
          messageApi.error(t('settings.members.statusUpdateFailed'));
          throw mutationError;
        } finally {
          setStatusUserId(null);
        }
      },
    });
  };

  const sections = [
    {
      key: 'members',
      title: t('settings.tabs.members'),
      description: t(getAdminSettingsPanelDescriptionKey('members'), {
        defaultValue:
          'Review users, update role bundles, and inspect recent login history.',
      }),
      content: (
        <UsersPanel
          users={filteredUsers}
          roles={roles}
          locale={locale}
          loading={usersLoading && users.length === 0}
          queryRefreshing={usersLoading && users.length > 0}
          errorMessage={usersError?.message ?? null}
          userSearch={userSearch}
          statusFilter={statusFilter}
          currentUserId={currentUserId}
          statusUserId={statusUserId}
          adminRoleIds={adminRoleIds}
          onSearchChange={setUserSearch}
          onStatusFilterChange={setStatusFilter}
          onEditUser={setEditingUser}
          onViewLoginRecords={setLoginTarget}
          onToggleStatus={handleUserStatusChange}
          onRetry={() => {
            void loadAllUsers(deferredUserSearch || undefined);
          }}
        />
      ),
    },
    {
      key: 'roles',
      title: t('settings.tabs.roles'),
      description: t(getAdminSettingsPanelDescriptionKey('roles'), {
        defaultValue:
          'Create custom roles and maintain reusable permission bundles.',
      }),
      content:
        roles.length > 0 || permissions.length > 0 ? (
          <RolesPanel
            roles={roles}
            permissions={permissions}
            creatingRole={creatingRole}
            savingRoleId={savingRoleId}
            updatingRole={updatingRole}
            onCreate={handleCreateRole}
            onSave={handleRoleSave}
          />
        ) : (
          <Empty description={t('settings.roles.empty')} />
        ),
    },
    {
      key: 'permissions',
      title: t('settings.tabs.permissions'),
      description: t(getAdminSettingsPanelDescriptionKey('permissions'), {
        defaultValue:
          'Inspect the full permission catalog available to this workspace.',
      }),
      content:
        permissions.length > 0 ? (
          <PermissionsPanel permissions={permissions} roles={roles} />
        ) : (
          <Empty description={t('settings.permissions.empty')} />
        ),
    },
  ];

  if (status === 'loading' || (!metaData && metaLoading && canReadAccessMetadata)) {
    return (
      <div
        style={{ display: 'flex', justifyContent: 'center', marginTop: '3rem' }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!canViewSettings) {
    return (
      <Card className="content-card" title={t('settings.title')}>
        <Alert
          type="warning"
          message={t('settings.adminOnly.title')}
          description={t('settings.adminOnly.description')}
        />
      </Card>
    );
  }

  if (!canReadAccessMetadata) {
    return (
      <Card
        className="content-card"
        title={t('adminConsole.links.settings.title', {
          defaultValue: 'Access Settings',
        })}
      >
        {messageContext}
        <Alert
          type="warning"
          message={t('settings.members.superAdminOnlyTitle')}
          description={t('settings.members.superAdminOnlyDescription')}
        />
      </Card>
    );
  }

  if (metaError && !metaData) {
    return (
      <Card
        className="content-card"
        title={t('adminConsole.links.settings.title', {
          defaultValue: 'Access Settings',
        })}
      >
        {messageContext}
        <Alert
          type="error"
          showIcon
          message={t('settings.members.loadFailed')}
          action={
            <Button size="small" onClick={() => void refetchMeta()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    );
  }

  if (!isOrgAdmin) {
    return (
      <Card
        className="content-card"
        title={t('adminConsole.links.settings.title', {
          defaultValue: 'Access Settings',
        })}
      >
        {messageContext}
        <Alert
          type="warning"
          message={t('settings.members.superAdminOnlyTitle')}
          description={t('settings.members.superAdminOnlyDescription')}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card
        className="content-card"
        title={t('adminConsole.links.settings.title', {
          defaultValue: 'Access Settings',
        })}
      >
        {messageContext}
        <Typography.Paragraph type="secondary" style={{ marginBottom: '1rem' }}>
          {t('adminConsole.links.settings.description', {
            defaultValue:
              'Manage users, roles, permissions, and recent login access history.',
          })}
        </Typography.Paragraph>
        {metaError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: '1rem' }}
            message={t('settings.members.loadFailed')}
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          {sections.map((section) => (
            <Button
              key={section.key}
              size="small"
              type={selectedPanel === section.key ? 'primary' : 'default'}
              onClick={() => handleSectionSelect(section.key)}
            >
              {section.title}
            </Button>
          ))}
        </div>
      </Card>

      {sections.map((section) => (
        <section
          key={section.key}
          id={section.key}
          ref={(node) => {
            sectionRefs.current[section.key] = node;
          }}
          className={`settings-section-shell scroll-mt-28 rounded-[28px] p-5 ${
            selectedPanel === section.key ? 'settings-section-shell--active' : ''
          }`}
        >
          <Typography.Title level={5} style={{ marginBottom: 6 }}>
            {section.title}
          </Typography.Title>
          <Typography.Paragraph
            type="secondary"
            style={{ marginBottom: '1rem' }}
          >
            {section.description}
          </Typography.Paragraph>
          {section.content}
        </section>
      ))}

      <UserAccessDrawer
        open={Boolean(editingUser)}
        user={editingUser}
        roles={roles}
        adminRoleIds={adminRoleIds}
        saving={savingUserAccess}
        onClose={() => setEditingUser(null)}
        onSave={handleUserAccessSave}
      />

      <UserLoginRecordsDrawer
        open={Boolean(loginTarget)}
        user={loginTarget}
        locale={locale}
        loading={loginRecordsLoading}
        records={
          loginTarget && loginRecordsUserId === loginTarget.id
            ? loginRecordsData?.userLoginRecords ?? []
            : []
        }
        error={loginRecordsError}
        onClose={() => {
          setLoginTarget(null);
          setLoginRecordsUserId(null);
        }}
        onRefresh={() => {
          if (!loginTarget) {
            return;
          }

          setLoginRecordsUserId(loginTarget.id);
          void loadLoginRecords({
            variables: {
              userId: loginTarget.id,
              limit: LOGIN_RECORD_LIMIT,
            },
          });
        }}
      />
    </div>
  );
}

function RolesPanel({
  roles,
  permissions,
  creatingRole,
  savingRoleId,
  updatingRole,
  onCreate,
  onSave,
}: {
  roles: RoleListItem[];
  permissions: PermissionListItem[];
  creatingRole: boolean;
  savingRoleId: string | null;
  updatingRole: boolean;
  onCreate: (values: CreateRoleFormValues) => Promise<void>;
  onSave: (roleId: string, values: RoleFormValues) => Promise<void>;
}) {
  const sortedPermissions = useMemo(
    () => [...permissions].sort((left, right) => left.name.localeCompare(right.name)),
    [permissions],
  );
  const sortedRoles = useMemo(
    () =>
      [...roles].sort((left, right) => {
        if (left.isSystem !== right.isSystem) {
          return Number(right.isSystem) - Number(left.isSystem);
        }
        return left.name.localeCompare(right.name);
      }),
    [roles],
  );

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <CreateRoleCard
        permissions={sortedPermissions}
        creatingRole={creatingRole}
        onCreate={onCreate}
      />
      <List
        dataSource={sortedRoles}
        renderItem={(role) => (
          <List.Item key={role.id}>
            <RoleInlineEditor
              role={role}
              permissions={sortedPermissions}
              saving={savingRoleId === role.id}
              updating={updatingRole}
              onSave={onSave}
            />
          </List.Item>
        )}
      />
    </Space>
  );
}

function CreateRoleCard({
  permissions,
  creatingRole,
  onCreate,
}: {
  permissions: PermissionListItem[];
  creatingRole: boolean;
  onCreate: (values: CreateRoleFormValues) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<CreateRoleFormValues>();

  const handleSubmit = async (values: CreateRoleFormValues) => {
    await onCreate(values);
    form.resetFields();
  };

  return (
    <Card size="small" title={t('settings.roles.createTitle')}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: '1rem' }}>
        {t('settings.roles.createDescription')}
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={(values) => void handleSubmit(values)}>
        <Form.Item
          label={t('settings.roles.name')}
          name="name"
          rules={[
            { required: true, message: t('settings.roles.nameRequired') },
            {
              validator: async (_, value: string | undefined) => {
                if (!value || value.trim().toLowerCase() !== 'admin') {
                  return;
                }
                throw new Error(t('settings.roles.nameReserved'));
              },
            },
          ]}
        >
          <Input
            maxLength={64}
            placeholder={t('settings.roles.namePlaceholder')}
            disabled={creatingRole}
          />
        </Form.Item>
        <Form.Item label={t('settings.roles.description')} name="description">
          <Input.TextArea
            rows={2}
            maxLength={240}
            placeholder={t('settings.roles.descriptionPlaceholder')}
            disabled={creatingRole}
          />
        </Form.Item>
        <Form.Item
          label={t('settings.roles.permissions')}
          name="permissions"
          rules={[
            { required: true, message: t('settings.roles.permissionsRequired') },
          ]}
        >
          <Select
            mode="multiple"
            optionFilterProp="label"
            placeholder={t('settings.roles.permissionsPlaceholder')}
            disabled={creatingRole || permissions.length === 0}
            options={permissions.map((permission) => ({
              value: permission.name,
              label: permission.name,
              title: permission.description ?? undefined,
            }))}
          />
        </Form.Item>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            type="primary"
            htmlType="submit"
            loading={creatingRole}
            disabled={permissions.length === 0}
          >
            {t('settings.roles.createAction')}
          </Button>
        </div>
      </Form>
    </Card>
  );
}

function RoleInlineEditor({
  role,
  permissions,
  saving,
  updating,
  onSave,
}: {
  role: RoleListItem;
  permissions: PermissionListItem[];
  saving: boolean;
  updating: boolean;
  onSave: (roleId: string, values: RoleFormValues) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<RoleFormValues>();
  const initialValues = useMemo(
    () => ({
      description: role.description ?? '',
      permissions: role.permissions.map((permission) => permission.name),
    }),
    [role.description, role.permissions],
  );

  useEffect(() => {
    form.setFieldsValue(initialValues);
  }, [form, initialValues]);

  const currentDescription =
    Form.useWatch('description', form) ?? initialValues.description;
  const currentPermissions =
    Form.useWatch('permissions', form) ?? initialValues.permissions;
  const isLocked = role.isSystem;
  const isBusy = isLocked || saving || updating;
  const hasChanges =
    !isLocked &&
    (currentDescription !== initialValues.description ||
      !haveSameItems(currentPermissions, initialValues.permissions));

  return (
    <Form
      form={form}
      layout="vertical"
      style={{ width: '100%' }}
      initialValues={initialValues}
      onFinish={(values) => void onSave(role.id, values)}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          {role.name}
        </Typography.Title>
        <Tag color={role.isSystem ? 'gold' : 'default'}>
          {role.isSystem ? t('settings.roles.system') : t('settings.roles.custom')}
        </Tag>
        <Tag>{t('settings.roles.permissionCount', { count: role.permissions.length })}</Tag>
      </div>
      <Form.Item label={t('settings.roles.description')} name="description">
        <Input.TextArea
          rows={2}
          maxLength={240}
          disabled={isBusy}
          placeholder={t('settings.roles.descriptionPlaceholder')}
        />
      </Form.Item>
      <Form.Item
        label={t('settings.roles.permissions')}
        name="permissions"
        rules={[
          { required: true, message: t('settings.roles.permissionsRequired') },
        ]}
      >
        <Select
          mode="multiple"
          optionFilterProp="label"
          placeholder={t('settings.roles.permissionsPlaceholder')}
          options={permissions.map((permission) => ({
            label: permission.name,
            value: permission.name,
            title: permission.description ?? undefined,
          }))}
          disabled={isBusy}
        />
      </Form.Item>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
        <Button onClick={() => form.setFieldsValue(initialValues)} disabled={!hasChanges || isBusy}>
          {t('common.reset')}
        </Button>
        <Button
          type="primary"
          htmlType="submit"
          loading={saving}
          disabled={!hasChanges || isBusy}
        >
          {t('settings.roles.saveChanges')}
        </Button>
      </div>
    </Form>
  );
}

function PermissionsPanel({
  permissions,
  roles,
}: {
  permissions: PermissionListItem[];
  roles: RoleListItem[];
}) {
  const { t } = useTranslation();
  const adminRoleIds = useMemo(() => getSystemAdminRoleIds(roles), [roles]);
  const usageMap = useMemo(() => {
    const map = new Map<string, Array<{ id: string; name: string; isAdmin: boolean }>>();
    for (const role of roles) {
      for (const permission of role.permissions) {
        const entry = map.get(permission.name) ?? [];
        entry.push({
          id: role.id,
          name: role.name,
          isAdmin: adminRoleIds.includes(role.id),
        });
        map.set(permission.name, entry);
      }
    }
    return map;
  }, [adminRoleIds, roles]);

  const columns = useMemo<TableColumnsType<PermissionListItem>>(
    () => [
      {
        title: t('settings.permissions.name'),
        dataIndex: 'name',
        key: 'name',
        render: (_value, record) => (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{record.name}</Typography.Text>
            <Typography.Text type="secondary">
              {record.description || t('settings.permissions.pending')}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: t('settings.permissions.usedBy'),
        key: 'usedBy',
        render: (_value, record) => {
          const rolesForPermission = usageMap.get(record.name) ?? [];

          if (rolesForPermission.length === 0) {
            return <Typography.Text type="secondary">{t('common.none')}</Typography.Text>;
          }

          return (
            <Space size={[6, 6]} wrap>
              {rolesForPermission
                .sort((left, right) => left.name.localeCompare(right.name))
                .map((role) => (
                  <Tag key={`${record.id}-${role.id}`} color={role.isAdmin ? 'gold' : 'default'}>
                    {role.name}
                  </Tag>
                ))}
            </Space>
          );
        },
      },
    ],
    [t, usageMap],
  );

  return (
    <Table
      rowKey="id"
      columns={columns}
      dataSource={[...permissions].sort((left, right) => left.name.localeCompare(right.name))}
      pagination={false}
      scroll={{ x: 820 }}
    />
  );
}

function UsersPanel({
  users,
  roles,
  locale,
  loading,
  queryRefreshing,
  errorMessage,
  userSearch,
  statusFilter,
  currentUserId,
  statusUserId,
  adminRoleIds,
  onSearchChange,
  onStatusFilterChange,
  onEditUser,
  onViewLoginRecords,
  onToggleStatus,
  onRetry,
}: {
  users: UserListItem[];
  roles: RoleListItem[];
  locale: ReturnType<typeof resolveLocale>;
  loading: boolean;
  queryRefreshing: boolean;
  errorMessage: string | null;
  userSearch: string;
  statusFilter: UserStatusFilter;
  currentUserId: string | null;
  statusUserId: string | null;
  adminRoleIds: string[];
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: UserStatusFilter) => void;
  onEditUser: (user: UserListItem) => void;
  onViewLoginRecords: (user: UserListItem) => void;
  onToggleStatus: (user: UserListItem, nextIsActive: boolean) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const roleMap = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);

  const columns = useMemo<TableColumnsType<UserListItem>>(
    () => [
      {
        title: t('settings.members.columns.user'),
        dataIndex: 'email',
        key: 'user',
        width: 240,
        render: (_value, record) => {
          const readOnlyReason = getReadOnlyReason(
            record,
            adminRoleIds,
            currentUserId,
          );

          return (
            <Space direction="vertical" size={2}>
              <Space size={[6, 6]} wrap>
                <Typography.Text strong>{getUserDisplayName(record)}</Typography.Text>
                {readOnlyReason === 'self' ? (
                  <Tag>{t('settings.members.readOnlySelf')}</Tag>
                ) : null}
                {readOnlyReason === 'admin' ? (
                  <Tag color="gold">{t('settings.members.readOnlyAdmin')}</Tag>
                ) : null}
              </Space>
              <Typography.Text type="secondary">{record.email}</Typography.Text>
            </Space>
          );
        },
      },
      {
        title: t('settings.members.columns.status'),
        dataIndex: 'isActive',
        key: 'status',
        width: 150,
        render: (value) => (
          <Tag color={value ? 'green' : 'volcano'}>
            {value ? t('settings.members.status.active') : t('settings.members.status.inactive')}
          </Tag>
        ),
      },
      {
        title: t('settings.members.columns.verification'),
        dataIndex: 'emailVerified',
        key: 'emailVerified',
        width: 180,
        render: (value) =>
          value ? (
            <Tag color="cyan">{t('settings.members.verification.verified')}</Tag>
          ) : (
            <Tag>{t('settings.members.verification.unverified')}</Tag>
          ),
      },
      {
        title: t('settings.members.columns.primaryRole'),
        dataIndex: 'primaryRoleId',
        key: 'primaryRoleId',
        width: 160,
        render: (value) => {
          if (!value) {
            return <Typography.Text type="secondary">{t('common.emptyValue')}</Typography.Text>;
          }

          const role = roleMap.get(value);
          return (
            <Tag color={adminRoleIds.includes(value) ? 'gold' : role?.isSystem ? 'blue' : 'default'}>
              {role?.name ?? value}
            </Tag>
          );
        },
      },
      {
        title: t('settings.members.columns.roles'),
        dataIndex: 'roleIds',
        key: 'roleIds',
        width: 280,
        render: (_value, record) => {
          const roleNames = getUserRoleNames(record, roles);
          if (roleNames.length === 0) {
            return <Typography.Text type="secondary">{t('common.emptyValue')}</Typography.Text>;
          }

          return (
            <Space size={[6, 6]} wrap>
              {normalizeRoleSelection(record.primaryRoleId, record.roleIds).map((roleId, index) => {
                const role = roleMap.get(roleId);
                return (
                  <Tag
                    key={`${record.id}-${roleId}-${index}`}
                    color={
                      adminRoleIds.includes(roleId)
                        ? 'gold'
                        : role?.isSystem
                          ? 'blue'
                          : 'default'
                    }
                  >
                    {role?.name ?? roleNames[index] ?? roleId}
                  </Tag>
                );
              })}
            </Space>
          );
        },
      },
      {
        title: t('settings.members.columns.lastLogin'),
        dataIndex: 'lastLoginAt',
        key: 'lastLoginAt',
        width: 200,
        render: (value) => {
          const formatted = formatOptionalDateTime(value, locale);
          return (
            <Typography.Text type={formatted ? undefined : 'secondary'}>
              {formatted ?? t('settings.members.neverLoggedIn')}
            </Typography.Text>
          );
        },
      },
      {
        title: t('common.actions'),
        key: 'actions',
        fixed: 'right',
        width: 280,
        render: (_value, record) => {
          const readOnlyReason = getReadOnlyReason(
            record,
            adminRoleIds,
            currentUserId,
          );
          const disabled = Boolean(readOnlyReason);
          const loginHistoryDisabled = !canViewLoginHistory(readOnlyReason);
          const nextIsActive = !record.isActive;

          return (
            <Space size={[8, 8]} wrap>
              <Button
                size="small"
                onClick={() => onEditUser(record)}
                disabled={disabled}
              >
                {t('settings.members.actions.editAccess')}
              </Button>
              <Button
                size="small"
                onClick={() => onViewLoginRecords(record)}
                disabled={loginHistoryDisabled}
              >
                {t('settings.members.actions.viewLogins')}
              </Button>
              <Button
                size="small"
                danger={!nextIsActive}
                loading={statusUserId === record.id}
                onClick={() => onToggleStatus(record, nextIsActive)}
                disabled={disabled}
              >
                {nextIsActive
                  ? t('settings.members.actions.enable')
                  : t('settings.members.actions.disable')}
              </Button>
            </Space>
          );
        },
      },
    ],
    [
      adminRoleIds,
      currentUserId,
      locale,
      onEditUser,
      onToggleStatus,
      onViewLoginRecords,
      roles,
      roleMap,
      statusUserId,
      t,
    ],
  );

  return (
    <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
      {errorMessage ? (
        <Alert
          type="error"
          showIcon
          message={errorMessage}
          action={
            <Button size="small" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : null}
      <Space size={[12, 12]} wrap>
        <Input.Search
          allowClear
          style={{ width: 280 }}
          placeholder={t('settings.members.searchPlaceholder')}
          value={userSearch}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <Select
          value={statusFilter}
          style={{ width: 180 }}
          onChange={onStatusFilterChange}
          options={[
            { value: 'all', label: t('settings.members.filters.all') },
            { value: 'active', label: t('settings.members.status.active') },
            { value: 'inactive', label: t('settings.members.status.inactive') },
          ]}
        />
        <Typography.Text type="secondary">
          {queryRefreshing
            ? t('common.loading')
            : t('settings.members.count', { count: users.length })}
        </Typography.Text>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={users}
        loading={loading}
        pagination={{ pageSize: 10, hideOnSinglePage: users.length <= 10 }}
        locale={{
          emptyText: <Empty description={t('settings.members.empty')} />,
        }}
        scroll={{ x: 1260 }}
      />
    </Space>
  );
}

function UserAccessDrawer({
  open,
  user,
  roles,
  adminRoleIds,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  user: UserListItem | null;
  roles: RoleListItem[];
  adminRoleIds: string[];
  saving: boolean;
  onClose: () => void;
  onSave: (user: UserListItem, primaryRoleId: string, roleIds: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const assignableRoles = useMemo(
    () => getAssignableRoles(roles, adminRoleIds),
    [adminRoleIds, roles],
  );
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [primaryRoleId, setPrimaryRoleId] = useState<string>();

  useEffect(() => {
    if (!user) {
      setSelectedRoleIds([]);
      setPrimaryRoleId(undefined);
      return;
    }

    const normalizedRoleIds = normalizeRoleSelection(
      user.primaryRoleId ?? user.roleIds[0],
      user.roleIds,
    );
    setSelectedRoleIds(normalizedRoleIds);
    setPrimaryRoleId(user.primaryRoleId ?? normalizedRoleIds[0]);
  }, [user]);

  const normalizedSelectedRoleIds = useMemo(
    () => normalizeRoleSelection(primaryRoleId, selectedRoleIds),
    [primaryRoleId, selectedRoleIds],
  );
  const initialRoleIds = useMemo(
    () =>
      normalizeRoleSelection(user?.primaryRoleId ?? user?.roleIds[0], user?.roleIds ?? []),
    [user],
  );
  const initialPrimaryRoleId = user?.primaryRoleId ?? initialRoleIds[0];
  const permissionPreview = useMemo(
    () => getPermissionPreview(normalizedSelectedRoleIds, assignableRoles),
    [assignableRoles, normalizedSelectedRoleIds],
  );
  const hasChanges =
    Boolean(user) &&
    (primaryRoleId !== initialPrimaryRoleId ||
      !haveSameItems(normalizedSelectedRoleIds, initialRoleIds));

  const handleRolesChange = (nextRoleIds: string[]) => {
    const normalizedRoleIds = normalizeRoleSelection(undefined, nextRoleIds);
    const nextPrimaryRoleId =
      primaryRoleId && normalizedRoleIds.includes(primaryRoleId)
        ? primaryRoleId
        : normalizedRoleIds[0];
    setSelectedRoleIds(normalizedRoleIds);
    setPrimaryRoleId(nextPrimaryRoleId);
  };

  const handlePrimaryRoleChange = (nextPrimaryRoleId: string) => {
    setPrimaryRoleId(nextPrimaryRoleId);
    setSelectedRoleIds((currentRoleIds) =>
      normalizeRoleSelection(nextPrimaryRoleId, currentRoleIds),
    );
  };

  return (
    <Drawer
      open={open}
      width={480}
      title={t('settings.members.editAccessTitle', {
        name: user ? getUserDisplayName(user) : t('settings.members.editAccessFallbackTitle'),
      })}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!user || !primaryRoleId || normalizedSelectedRoleIds.length === 0 || !hasChanges}
            onClick={() => {
              if (!user || !primaryRoleId) {
                return;
              }
              void onSave(user, primaryRoleId, normalizedSelectedRoleIds);
            }}
          >
            {t('common.save')}
          </Button>
        </Space>
      }
    >
      {user ? (
        <Space direction="vertical" size="large" style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message={t('settings.members.editAccessHintTitle')}
            description={t('settings.members.editAccessHintDescription')}
          />

          <div>
            <Typography.Title level={5} style={{ marginBottom: '0.5rem' }}>
              {getUserDisplayName(user)}
            </Typography.Title>
            <Typography.Text type="secondary">{user.email}</Typography.Text>
          </div>

          <Form layout="vertical">
            <Form.Item label={t('settings.members.primaryRoleLabel')} required>
              <Select
                value={primaryRoleId}
                onChange={handlePrimaryRoleChange}
                placeholder={t('settings.members.primaryRolePlaceholder')}
                options={assignableRoles.map((role) => ({
                  value: role.id,
                  label: role.name,
                }))}
              />
            </Form.Item>
            <Form.Item label={t('settings.members.rolesLabel')} required>
              <Select
                mode="multiple"
                value={selectedRoleIds}
                onChange={handleRolesChange}
                placeholder={t('settings.members.rolesPlaceholder')}
                optionFilterProp="label"
                options={assignableRoles.map((role) => ({
                  value: role.id,
                  label: role.name,
                }))}
              />
            </Form.Item>
          </Form>

          <div>
            <Typography.Title level={5} style={{ marginBottom: '0.5rem' }}>
              {t('settings.members.permissionPreviewTitle')}
            </Typography.Title>
            {permissionPreview.length > 0 ? (
              <List
                size="small"
                dataSource={permissionPreview}
                renderItem={(permission) => (
                  <List.Item key={permission.name}>
                    <List.Item.Meta
                      title={permission.name}
                      description={
                        permission.description || t('settings.permissions.pending')
                      }
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty description={t('settings.members.permissionPreviewEmpty')} />
            )}
          </div>
        </Space>
      ) : null}
    </Drawer>
  );
}

function UserLoginRecordsDrawer({
  open,
  user,
  locale,
  loading,
  records,
  error,
  onClose,
  onRefresh,
}: {
  open: boolean;
  user: UserListItem | null;
  locale: ReturnType<typeof resolveLocale>;
  loading: boolean;
  records: UserLoginRecordListItem[];
  error?: Error | undefined;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Drawer
      open={open}
      width={520}
      title={t('settings.members.loginRecordsTitle', {
        name: user ? getUserDisplayName(user) : t('settings.members.loginRecordsFallbackTitle'),
      })}
      onClose={onClose}
      extra={
        <Button onClick={onRefresh} loading={loading}>
          {t('common.refresh')}
        </Button>
      }
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: '1rem' }}
          message={t('settings.members.loginRecordsLoadFailed')}
        />
      ) : null}
      {loading && records.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem 0' }}>
          <Spin />
        </div>
      ) : records.length > 0 ? (
        <List
          itemLayout="vertical"
          dataSource={records}
          renderItem={(record) => (
            <List.Item key={record.id}>
              <Space direction="vertical" size={4} style={{ display: 'flex' }}>
                <Space size={[8, 8]} wrap>
                  <Typography.Text strong>
                    {formatOptionalDateTime(record.createdAt, locale) ?? record.createdAt}
                  </Typography.Text>
                  <Tag color={record.method === 'password' ? 'blue' : 'cyan'}>
                    {getLoginMethodLabel(record.method, t)}
                  </Tag>
                </Space>
                <Typography.Text type="secondary">
                  {t('settings.members.loginRecordIp', {
                    value: record.ipAddress ?? t('common.emptyValue'),
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t('settings.members.loginRecordUserAgent', {
                    value: record.userAgent ?? t('common.emptyValue'),
                  })}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      ) : (
        <Empty description={t('settings.members.loginRecordsEmpty')} />
      )}
    </Drawer>
  );
}
