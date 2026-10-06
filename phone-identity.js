import { createHmac, randomBytes } from 'node:crypto';

// A phone is a room-local lookup, not proof of ownership. The friends-only
// product deliberately does not verify it. Never return or log the input.
export function canonicalPhone(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('请输入有效的手机号');
  let clean = value.normalize('NFKC').trim();
  if (!/^[+\d\s()-]+$/u.test(clean)) throw new Error('请输入有效的手机号');
  clean = clean.replace(/[\s()-]/gu, '');
  if (clean.startsWith('00')) clean = `+${clean.slice(2)}`;
  if (/^1[3-9]\d{9}$/.test(clean)) clean = `+86${clean}`;
  if (!/^\+[1-9]\d{7,14}$/.test(clean) ||
      (clean.startsWith('+86') && !/^\+861[3-9]\d{9}$/.test(clean))) {
    throw new Error('请输入有效的手机号；境外号码请加国家区号');
  }
  return clean;
}

export function newPhoneIdentity() {
  return { version: 1, key: randomBytes(32).toString('hex') };
}

export function validatePhoneIdentity(value) {
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.key)) {
    throw new Error('房间身份索引无效');
  }
  return { version: 1, key: value.key };
}

export function phoneLookup(identity, code, phone) {
  return createHmac('sha256', Buffer.from(identity.key, 'hex'))
    .update('room-phone-v1\0').update(code).update('\0').update(canonicalPhone(phone)).digest('hex');
}
