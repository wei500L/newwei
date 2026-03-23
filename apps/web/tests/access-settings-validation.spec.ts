import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('access settings role validation feedback', () => {
  it('surfaces create-role validation failures explicitly', () => {
    const source = read('components/settings/access-settings-content.tsx');

    expect(source).toContain("const { message: messageApi } = App.useApp();");
    expect(source).toContain(
      "const handleFinishFailed: FormProps<CreateRoleFormValues>['onFinishFailed']",
    );
    expect(source).toContain("form.scrollToField(firstError.name, {");
    expect(source).toContain("messageApi.warning(t('settings.roles.validationFailed'));");
    expect(source).toContain("scrollToFirstError={{ block: 'center' }}");
    expect(source).toContain('onFinishFailed={handleFinishFailed}');
  });
});
