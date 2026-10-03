import test from 'node:test';
import assert from 'node:assert/strict';
import { authStatus } from '../scripts/auth-status.mjs';

test('auth status: missing credentials are explicit, never faked as live delivery', () => {
  const status = authStatus({});
  assert.equal(status.email.configured, false); assert.equal(status.phone.configured, false);
  assert.equal(status.liveDeliveryVerified, false);
  assert.ok(status.email.missing.includes('RESEND_API_KEY')); assert.ok(status.phone.missing.includes('TENCENT_SMS_TEMPLATE_ID'));
  assert.equal(status.production.secretReady, false); assert.equal(status.production.httpsOriginReady, false);
});

test('auth status: configuration summary contains no credential or personal values', () => {
  const env = { RESEND_API_KEY: 'fixture-mail-key-private', MEMBERSHIP_EMAIL_FROM: 'secret-sender@fixture.test',
    TENCENT_SMS_SECRET_ID: 'AKIDprivateFixture', TENCENT_SMS_SECRET_KEY: 'privateFixtureSecret', TENCENT_SMS_APP_ID: '1400000000',
    TENCENT_SMS_SIGN_NAME: '人生指南', TENCENT_SMS_TEMPLATE_ID: '1234567890',
    MEMBERSHIP_AUTH_SECRET: 'fixture-production-private-secret-32-characters', MEMBERSHIP_APP_ORIGIN: 'https://fixture.test',
    MEMBERSHIP_DB_PATH: '/private/fixture.sqlite', MEMBERSHIP_ENFORCE: 'true' };
  const status = authStatus(env), output = JSON.stringify(status);
  assert.equal(status.email.configured, true); assert.equal(status.phone.configured, true);
  assert.equal(status.production.secretReady, true); assert.equal(status.production.httpsOriginReady, true);
  for (const value of Object.values(env)) if (value.length > 5) assert.ok(!output.includes(value), value);
  assert.equal(status.liveDeliveryVerified, false);
  for (const origin of ['http://fixture.test', 'https://fixture.test/extra', 'https://user:secret@fixture.test']) {
    assert.equal(authStatus({ ...env, MEMBERSHIP_APP_ORIGIN: origin }).production.httpsOriginReady, false);
  }
});
