<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  attributeKeywords,
  databasePrivileges,
  newRoleAttributes,
  roleStatements,
  schemaPrivileges,
  type Role,
  type RoleAttributes
} from '@shared/sql/postgres-roles'
import { inTransaction } from '@shared/sql/transaction'
import type { Workspace } from '@/workspace/workspace'
import { reviewAndApply } from '@/workspace/review'
import { confirm } from '@/dialogs'
import { t } from '@/i18n'
import type { AdminTab } from './admin'

/** Users and Privileges of a PostgreSQL server: its roles, their attributes, memberships and privileges on this database. */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

type DetailTab = 'login' | 'attributes' | 'members' | 'privileges'
const detailTabs: [DetailTab, string][] = [
  ['login', t('admin.users.tabLogin')],
  ['attributes', t('admin.roles.tabAttributes')],
  ['members', t('admin.roles.tabMemberOf')],
  ['privileges', t('admin.users.privileges')]
]

const attributeLabels: Record<keyof RoleAttributes, string> = {
  login: t('admin.roles.attrLogin'),
  superuser: t('admin.roles.attrSuperuser'),
  createdb: t('admin.roles.attrCreatedb'),
  createrole: t('admin.roles.attrCreaterole'),
  inherit: t('admin.roles.attrInherit'),
  replication: t('admin.roles.attrReplication'),
  bypassrls: t('admin.roles.attrBypassrls')
}

const roles = ref<string[]>([])
/** Every role, predefined ones (pg_*) included, for the Member Of list. */
const allRoles = ref<string[]>([])
const schemas = ref<string[]>([])
const database = ref('')
const filter = ref('')
/** Role shown in the details, null while a new role is being defined. */
const current = ref<string | null>(null)
const original = ref<Role | null>(null)
const draft = ref<Role | null>(null)
const password = ref('')
const confirmPassword = ref('')
const detailTab = ref<DetailTab>('login')
const error = ref('')

const q = (sql: string, params?: unknown[]) => props.ws.query(sql, params)
const yes = (v: unknown): boolean => v === 'true' || v === true
const clone = (r: Role): Role => JSON.parse(JSON.stringify(r))

const visibleRoles = computed(() => {
  const f = filter.value.trim().toLowerCase()
  return f ? roles.value.filter((r) => r.toLowerCase().includes(f)) : roles.value
})
const isNew = computed(() => !!draft.value && current.value === null)
const dirty = computed(
  () => !!draft.value && (isNew.value || !!password.value || !!confirmPassword.value || JSON.stringify(draft.value) !== JSON.stringify(original.value))
)
const memberOptions = computed(() => allRoles.value.filter((r) => r !== current.value))

async function loadLists(): Promise<void> {
  const [all, ns, [db]] = await Promise.all([
    q('SELECT rolname AS name FROM pg_roles ORDER BY rolname'),
    q("SELECT nspname AS name FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY 1"),
    q('SELECT current_database() AS name')
  ])
  allRoles.value = all.map((r) => String(r.name))
  roles.value = allRoles.value.filter((r) => !r.startsWith('pg_'))
  schemas.value = ns.map((r) => String(r.name))
  database.value = String(db.name)
}

async function loadRole(name: string): Promise<Role> {
  const [r] = await q(
    `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit,
            coalesce(rolvaliduntil::text, '') AS valid_until
     FROM pg_roles WHERE rolname = $1`,
    [name]
  )
  if (!r) throw new Error(t('admin.roles.roleGone', { name }))
  const [members, dbPrivileges, nsPrivileges] = await Promise.all([
    q(
      `SELECT g.rolname AS name FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
       WHERE u.rolname = $1 ORDER BY 1`,
      [name]
    ),
    q(
      `SELECT a.privilege_type AS privilege FROM pg_database d, aclexplode(d.datacl) a
       WHERE d.datname = current_database() AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [name]
    ),
    q(
      `SELECT n.nspname AS schema, a.privilege_type AS privilege FROM pg_namespace n, aclexplode(n.nspacl) a
       WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY 1`,
      [name]
    )
  ])
  const bySchema = new Map<string, string[]>()
  for (const row of nsPrivileges) bySchema.set(String(row.schema), [...(bySchema.get(String(row.schema)) ?? []), String(row.privilege)])
  const ordered = (names: string[], known: string[]): string[] => known.filter((p) => names.includes(p))
  return {
    name,
    attributes: {
      login: yes(r.rolcanlogin),
      superuser: yes(r.rolsuper),
      createdb: yes(r.rolcreatedb),
      createrole: yes(r.rolcreaterole),
      inherit: yes(r.rolinherit),
      replication: yes(r.rolreplication),
      bypassrls: yes(r.rolbypassrls)
    },
    connectionLimit: Number(r.rolconnlimit),
    validUntil: String(r.valid_until),
    memberOf: members.map((m) => String(m.name)),
    database: ordered(
      dbPrivileges.map((p) => String(p.privilege)),
      databasePrivileges
    ),
    schemas: [...bySchema].map(([schema, privileges]) => ({ schema, privileges: ordered(privileges, schemaPrivileges) }))
  }
}

function blankRole(): Role {
  return { name: 'newrole', attributes: { ...newRoleAttributes }, connectionLimit: -1, validUntil: '', memberOf: [], database: ['CONNECT'], schemas: [] }
}

/** Shows a role (null: a new one) in the details, discarding any edit. */
async function show(name: string | null): Promise<void> {
  error.value = ''
  password.value = confirmPassword.value = ''
  try {
    const role = name === null ? blankRole() : await loadRole(name)
    current.value = name
    original.value = name === null ? null : role
    draft.value = clone(role)
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function canDiscard(): Promise<boolean> {
  return !dirty.value || (await confirm(t('admin.roles.discardRole'), undefined, t('admin.users.discard')))
}

async function select(name: string): Promise<void> {
  if (current.value === name || !(await canDiscard())) return
  await show(name)
}

async function addRole(): Promise<void> {
  if (!(await canDiscard())) return
  await show(null)
  detailTab.value = 'login'
}

async function refresh(): Promise<void> {
  if (!(await canDiscard())) return
  error.value = ''
  try {
    await loadLists()
    if (current.value && roles.value.includes(current.value)) await show(current.value)
    else if (current.value) current.value = original.value = draft.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function removeRole(): Promise<void> {
  if (current.value === null) {
    draft.value = null
    return
  }
  // the privileges this page shows would make DROP ROLE fail: revoked first
  const role = original.value!
  const revokes = roleStatements(role, { ...role, database: [], schemas: [] }, null, database.value)
  if (await reviewAndApply(props.ws, inTransaction([...revokes, `DROP ROLE ${props.ws.dialect.quoteIdentifier(current.value)}`]))) {
    current.value = original.value = draft.value = null
    await loadLists()
  }
}

async function apply(): Promise<void> {
  if (!draft.value) return
  error.value = ''
  if (password.value !== confirmPassword.value) {
    error.value = t('admin.users.passwordMismatch')
    return
  }
  draft.value.connectionLimit = Math.trunc(Number(draft.value.connectionLimit))
  if (!Number.isFinite(draft.value.connectionLimit) || draft.value.connectionLimit < -1) draft.value.connectionLimit = -1
  let statements: string[]
  try {
    statements = roleStatements(original.value, draft.value, password.value ? password.value : null, database.value)
  } catch (e) {
    error.value = (e as Error).message
    return
  }
  if (!statements.length) {
    error.value = t('admin.users.noChanges')
    return
  }
  if (await reviewAndApply(props.ws, inTransaction(statements))) {
    const name = draft.value.name
    await loadLists()
    await show(name)
  }
}

function toggle(list: string[], name: string, on: boolean): string[] {
  return on ? [...new Set([...list, name])] : list.filter((n) => n !== name)
}

function schemaEntry(schema: string): string[] {
  return draft.value?.schemas.find((s) => s.schema === schema)?.privileges ?? []
}

function toggleSchema(schema: string, privilege: string, on: boolean): void {
  if (!draft.value) return
  const privileges = schemaPrivileges.filter((p) => toggle(schemaEntry(schema), privilege, on).includes(p))
  draft.value.schemas = [...draft.value.schemas.filter((s) => s.schema !== schema), ...(privileges.length ? [{ schema, privileges }] : [])]
}

const checked = (e: Event): boolean => (e.target as HTMLInputElement).checked

onMounted(async () => {
  try {
    await loadLists()
  } catch (e) {
    error.value = (e as Error).message
  }
})
</script>

<template>
  <div class="page users">
    <div class="page-header">{{ t('workspace.admin.users') }}</div>
    <div class="body">
      <section class="accounts">
        <div class="section-title">{{ t('admin.roles.roles') }}</div>
        <input v-model="filter" type="search" class="filter" :placeholder="t('admin.roles.filter')" />
        <div class="scroller">
          <table class="list">
            <thead>
              <tr><th>{{ t('admin.users.role') }}</th></tr>
            </thead>
            <tbody>
              <tr v-if="isNew" class="selected new">
                <td>{{ draft?.name }}</td>
              </tr>
              <tr v-for="r in visibleRoles" :key="r" :class="{ selected: current === r }" @mousedown="select(r)">
                <td>{{ r }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="buttons">
          <button :disabled="ws.busy" @click="addRole">{{ t('admin.roles.addRole') }}</button>
          <button :disabled="ws.busy || !draft" @click="removeRole">{{ t('common.delete') }}</button>
          <button :disabled="ws.busy" @click="refresh">{{ t('admin.refresh') }}</button>
        </div>
      </section>

      <section class="details">
        <template v-if="draft">
          <div class="section-title">{{ isNew ? t('admin.roles.detailsNew') : t('admin.roles.details', { name: current ?? '' }) }}</div>
          <div class="subtabs" role="tablist">
            <button
              v-for="[id, label] in detailTabs"
              :key="id"
              role="tab"
              :class="{ active: detailTab === id }"
              :aria-selected="detailTab === id"
              @click="detailTab = id"
            >
              {{ label }}
            </button>
          </div>

          <div class="tab-body">
            <div v-if="detailTab === 'login'" class="fields">
              <label for="pr-name">{{ t('admin.roles.roleName') }}</label>
              <input id="pr-name" v-model.trim="draft.name" type="text" spellcheck="false" />
              <span class="hint">{{ t('admin.roles.roleNameHint') }}</span>

              <label for="pr-pw">{{ t('admin.users.password') }}</label>
              <input id="pr-pw" v-model="password" type="password" autocomplete="new-password" />
              <span class="hint">{{ isNew ? t('admin.roles.passwordHintNew') : t('admin.users.passwordHint') }}</span>

              <label for="pr-pw2">{{ t('admin.users.confirmPassword') }}</label>
              <input id="pr-pw2" v-model="confirmPassword" type="password" autocomplete="new-password" />
              <span class="hint">{{ t('admin.users.confirmPasswordHint') }}</span>

              <label for="pr-valid">{{ t('admin.roles.validUntil') }}</label>
              <input id="pr-valid" v-model.trim="draft.validUntil" type="text" :placeholder="t('admin.roles.noExpiry')" spellcheck="false" />
              <span class="hint">{{ t('admin.roles.validUntilHint') }}</span>

              <label for="pr-limit">{{ t('admin.roles.connectionLimit') }}</label>
              <input id="pr-limit" v-model.number="draft.connectionLimit" type="number" min="-1" />
              <span class="hint">{{ t('admin.roles.connectionLimitHint') }}</span>
            </div>

            <div v-else-if="detailTab === 'attributes'" class="attributes">
              <label v-for="(keyword, key) in attributeKeywords" :key="key" class="check">
                <input v-model="draft.attributes[key]" type="checkbox" />
                <span class="mono">{{ keyword }}</span>
                <span class="muted">{{ attributeLabels[key] }}</span>
              </label>
            </div>

            <div v-else-if="detailTab === 'members'" class="pane members">
              <label v-for="r in memberOptions" :key="r" class="check">
                <input type="checkbox" :checked="draft.memberOf.includes(r)" @change="draft.memberOf = toggle(draft.memberOf, r, checked($event))" />
                {{ r }}
              </label>
            </div>

            <div v-else class="schemas">
              <fieldset>
                <legend>{{ t('admin.roles.database', { name: database }) }}</legend>
                <label v-for="p in databasePrivileges" :key="p" class="check">
                  <input type="checkbox" :checked="draft.database.includes(p)" @change="draft.database = toggle(draft.database, p, checked($event))" />
                  {{ p }}
                </label>
              </fieldset>
              <div class="pane">
                <table class="list">
                  <thead>
                    <tr>
                      <th>{{ t('admin.users.schema') }}</th>
                      <th v-for="p in schemaPrivileges" :key="p">{{ p }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="s in schemas" :key="s">
                      <td class="mono">{{ s }}</td>
                      <td v-for="p in schemaPrivileges" :key="p">
                        <input
                          type="checkbox"
                          :checked="schemaEntry(s).includes(p)"
                          :aria-label="t('admin.roles.privilegeOn', { privilege: p, schema: s })"
                          @change="toggleSchema(s, p, checked($event))"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="hint">{{ t('admin.roles.privilegesHint') }}</p>
            </div>
          </div>
        </template>
        <div v-else class="empty-state">{{ t('admin.roles.selectRole') }}</div>

        <p v-if="error" class="error selectable">{{ error }}</p>
        <div class="actions">
          <button :disabled="!dirty || ws.busy" @click="show(current)">{{ t('common.revert') }}</button>
          <button class="primary" :disabled="!dirty || ws.busy" @click="apply">{{ t('common.apply') }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped src="./accounts.css"></style>

<style scoped>
.section-title {
  font-weight: 600;
  padding: 8px 10px 6px;
}

.accounts {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}

.buttons {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
}

.fields > label {
  text-align: right;
  color: var(--text-muted);
}

.hint {
  color: var(--text-muted);
  font-size: var(--fs-small);
}

.attributes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attributes .mono {
  min-width: 110px;
}

.members {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px;
  max-height: 100%;
}

.schemas .pane {
  max-height: 260px;
}

fieldset {
  border: 1px solid var(--border);
  border-radius: 5px;
  display: flex;
  gap: 14px;
  margin: 0;
  padding: 6px 10px 8px;
}
</style>
