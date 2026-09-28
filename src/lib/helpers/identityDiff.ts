import {
  IdentityChange,
  IdentityField,
  IdentitySnapshot,
} from '../repositories/identityTypes.js';

const FIELDS: { field: IdentityField; key: keyof IdentitySnapshot }[] = [
  { field: 'user_avatar', key: 'userAvatarHash' },
  { field: 'member_avatar', key: 'memberAvatarHash' },
  { field: 'nickname', key: 'nickname' },
  { field: 'username', key: 'username' },
  { field: 'global_name', key: 'globalName' },
];

/**
 * Field-by-field comparison of a stored baseline against a current snapshot.
 *
 * An absent baseline yields no changes: the first sighting of a member IS the
 * baseline. Reporting it as a change would make enabling the feature announce
 * every member in the guild as having changed identity.
 */
export function diffIdentity(
  before: IdentitySnapshot | undefined,
  after: IdentitySnapshot,
): IdentityChange[] {
  if (!before) {
    return [];
  }
  return FIELDS.filter(({ key }) => before[key] !== after[key]).map(
    ({ field, key }) => ({
      discordUserId: after.discordUserId,
      field,
      oldValue: before[key] ?? null,
      newValue: after[key] ?? null,
    }),
  );
}
