<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  databasePermissions,
  loginStatements,
  newLogin,
  newUser,
  schemaPermissions,
  userStatements,
  type DatabaseUser,
  type Login,
  type PermissionState,
  type Permissions
} from '@shared/sql/mssql-logins'
import { inTransaction } from '@shared/sql/transaction'
import { metadataQuery, yes } from '@/workspace/catalog/mssql'
import type { Workspace } from '@/workspace/workspace'
import { reviewAndApply } from '@/workspace/review'
import { confirm, prompt } from '@/dialogs'
import { t } from '@/i18n'
import type { AdminTab } from './admin'

/**
 * Users and Privileges of a SQL Server: the server's logins with their server
 * roles, and the users of this database (mapped to a login or without one)
 * with their roles and permissions on the database and its schemas.
 */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

type Kind = 'sql' | 'windows' | 'group' | 'user'
interface Entry {
  kind: Kind
  name: string
}
/** A login and its user in this database, or (login null) a user without login. */
interface Principal {
  login: Login | null
  user: DatabaseUser | null
}

type DetailTab = 'login' | 'serverRoles' | 'database' | 'permissions'
const detailTabLabels: Record<DetailTab, string> = {
  login: t('admin.users.tabLogin'),
  serverRoles: t('admin.logins.tabServerRoles'),
  database: t('admin.logins.tabDatabase'),
  permissions: t('admin.logins.tabPermissions')
}
const kindLabels: Record<Kind, string> = {
  sql: t('admin.logins.kindSql'),
  windows: t('admin.logins.kindWindows'),
  group: t('admin.logins.kindGroup'),
  user: t('admin.logins.kindUser')
}
const states: [PermissionState | '', string][] = [
  ['', t('admin.logins.stateNone')],
  ['GRANT', t('admin.logins.stateGrant')],
  ['GRANT_WITH_GRANT_OPTION', t('admin.logins.stateGrantOption')],
  ['DENY', t('admin.logins.stateDeny')]
]

const entries = ref<Entry[]>([])
const serverRoles = ref<string[]>([])
const databaseRoles = ref<string[]>([])
const schemas = ref<string[]>([])
const databases = ref<string[]>([])
const languages = ref<{ name: string; alias: string }[]>([])
const database = ref('')
const filter = ref('')
/** Entry shown in the details, null while a new login or user is being defined. */
const current = ref<Entry | null>(null)
const original = ref<Principal | null>(null)
const draft = ref<Principal | null>(null)
const password = ref('')
const confirmPassword = ref('')
const detailTab = ref<DetailTab>('login')
const error = ref('')

const q = metadataQuery((sql, params) => props.ws.query(sql, params))
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const sameEntry = (a: Entry | null, b: Entry | null): boolean => !!a && !!b && a.kind === b.kind && a.name === b.name

const visibleEntries = computed(() => {
  const f = filter.value.trim().toLowerCase()
  return f ? entries.value.filter((e) => e.name.toLowerCase().includes(f)) : entries.value
})
const isNew = computed(() => !!draft.value && current.value === null)
const dirty = computed(
  () => !!draft.value && (isNew.value || !!password.value || !!confirmPassword.value || JSON.stringify(draft.value) !== JSON.stringify(original.value))
)
const detailTabs = computed<DetailTab[]>(() => (draft.value?.login ? ['login', 'serverRoles', 'database', 'permissions'] : ['database', 'permissions']))
/** The login owning the database maps to dbo, which has every permission and cannot be altered. */
const ownerUser = computed(() => original.value?.user?.name === 'dbo')
const title = computed(() => {
  const login = draft.value?.login
  if (isNew.value) return login ? t('admin.logins.detailsNew') : t('admin.logins.detailsNewUser')
  const name = current.value?.name ?? ''
  return login ? t('admin.logins.details', { name }) : t('admin.logins.detailsUser', { name })
})

async function loadLists(): Promise<void> {
  const [logins, users, sr, dr, ns, dbs, langs, [db]] = await Promise.all([
    // ## logins are created from certificates, for internal use
    q("SELECT name, type FROM sys.server_principals WHERE type IN ('S', 'U', 'G') AND name NOT LIKE '##%' ORDER BY name"),
    // principal_id 1-4: dbo, guest, INFORMATION_SCHEMA, sys
    q(
      `SELECT dp.name FROM sys.database_principals dp LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid
       WHERE dp.type IN ('S', 'U', 'G') AND dp.principal_id > 4 AND sp.principal_id IS NULL ORDER BY dp.name`
    ),
    q("SELECT name FROM sys.server_principals WHERE type = 'R' AND name <> 'public' ORDER BY name"),
    q("SELECT name FROM sys.database_principals WHERE type = 'R' AND name <> 'public' ORDER BY name"),
    q('SELECT name FROM sys.schemas ORDER BY name'),
    q('SELECT name FROM sys.databases ORDER BY name'),
    q('SELECT name, alias FROM sys.syslanguages ORDER BY name'),
    q('SELECT DB_NAME() AS name')
  ])
  const loginKinds: Record<string, Kind> = { S: 'sql', U: 'windows', G: 'group' }
  entries.value = [
    ...logins.map((r) => ({ kind: loginKinds[String(r.type).trim()], name: String(r.name) })),
    ...users.map((r) => ({ kind: 'user' as const, name: String(r.name) }))
  ]
  serverRoles.value = sr.map((r) => String(r.name))
  databaseRoles.value = dr.map((r) => String(r.name))
  schemas.value = ns.map((r) => String(r.name)).filter((s) => s === 'dbo' || !props.ws.dialect.isSystemSchema(s))
  databases.value = dbs.map((r) => String(r.name))
  languages.value = langs.map((r) => ({ name: String(r.name), alias: String(r.alias) }))
  database.value = String(db.name)
}

async function loadLogin(name: string): Promise<{ login: Login; user: string | null }> {
  const [[r], roles, [mapped]] = await Promise.all([
    q(
      `SELECT p.type, p.is_disabled, p.default_database_name, p.default_language_name, l.is_policy_checked, l.is_expiration_checked
       FROM sys.server_principals p LEFT JOIN sys.sql_logins l ON l.principal_id = p.principal_id WHERE p.name = @p1`,
      [name]
    ),
    q(
      `SELECT r.name FROM sys.server_role_members m JOIN sys.server_principals r ON r.principal_id = m.role_principal_id
       JOIN sys.server_principals p ON p.principal_id = m.member_principal_id WHERE p.name = @p1 ORDER BY r.name`,
      [name]
    ),
    q('SELECT dp.name FROM sys.database_principals dp JOIN sys.server_principals sp ON sp.sid = dp.sid WHERE sp.name = @p1', [name])
  ])
  if (!r) throw new Error(t('admin.logins.gone', { name }))
  return {
    login: {
      name,
      windows: String(r.type).trim() !== 'S',
      defaultDatabase: String(r.default_database_name ?? 'master'),
      defaultLanguage: String(r.default_language_name ?? ''),
      disabled: yes(r.is_disabled),
      checkPolicy: yes(r.is_policy_checked),
      checkExpiration: yes(r.is_expiration_checked),
      serverRoles: roles.map((m) => String(m.name))
    },
    user: mapped ? String(mapped.name) : null
  }
}

async function loadUser(name: string): Promise<DatabaseUser> {
  const [[r], roles, permissions] = await Promise.all([
    q('SELECT default_schema_name FROM sys.database_principals WHERE name = @p1', [name]),
    q(
      `SELECT r.name FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
       JOIN sys.database_principals u ON u.principal_id = m.member_principal_id WHERE u.name = @p1 ORDER BY r.name`,
      [name]
    ),
    // class 0: the database, 3: a schema
    q(
      `SELECT pe.class, s.name AS schema_name, pe.permission_name, pe.state_desc FROM sys.database_permissions pe
       JOIN sys.database_principals u ON u.principal_id = pe.grantee_principal_id
       LEFT JOIN sys.schemas s ON pe.class = 3 AND s.schema_id = pe.major_id
       WHERE u.name = @p1 AND pe.class IN (0, 3)`,
      [name]
    )
  ])
  if (!r) throw new Error(t('admin.logins.gone', { name }))
  const onDatabase: Permissions = {}
  const bySchema = new Map<string, Permissions>()
  for (const p of permissions) {
    const state = String(p.state_desc) as PermissionState
    if (Number(p.class) === 0) onDatabase[String(p.permission_name)] = state
    else bySchema.set(String(p.schema_name), { ...bySchema.get(String(p.schema_name)), [String(p.permission_name)]: state })
  }
  return {
    name,
    defaultSchema: String(r.default_schema_name ?? ''),
    roles: roles.map((m) => String(m.name)),
    database: onDatabase,
    schemas: [...bySchema].map(([schema, permissions]) => ({ schema, permissions }))
  }
}

async function loadPrincipal(entry: Entry): Promise<Principal> {
  if (entry.kind === 'user') return { login: null, user: await loadUser(entry.name) }
  const { login, user } = await loadLogin(entry.name)
  return { login, user: user === null ? null : await loadUser(user) }
}

/** Shows an entry in the details (null: a new login, or a new user without login), discarding any edit. */
async function show(entry: Entry | null, kind: 'login' | 'user' = 'login'): Promise<void> {
  error.value = ''
  password.value = confirmPassword.value = ''
  try {
    const principal: Principal =
      entry !== null ? await loadPrincipal(entry) : kind === 'login' ? { login: { ...newLogin(), name: 'newlogin' }, user: newUser('') } : { login: null, user: newUser('newuser') }
    current.value = entry
    original.value = entry === null ? null : principal
    draft.value = clone(principal)
    if (!detailTabs.value.includes(detailTab.value)) detailTab.value = detailTabs.value[0]
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function canDiscard(): Promise<boolean> {
  return !dirty.value || (await confirm(t('admin.logins.discard'), undefined, t('admin.users.discard')))
}

async function select(entry: Entry): Promise<void> {
  if (sameEntry(current.value, entry) || !(await canDiscard())) return
  await show(entry)
}

async function add(kind: 'login' | 'user'): Promise<void> {
  if (!(await canDiscard())) return
  await show(null, kind)
  detailTab.value = detailTabs.value[0]
}

async function refresh(): Promise<void> {
  if (!(await canDiscard())) return
  error.value = ''
  try {
    await loadLists()
    if (current.value && entries.value.some((e) => sameEntry(e, current.value))) await show(current.value)
    else if (current.value) current.value = original.value = draft.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function remove(): Promise<void> {
  if (current.value === null || !original.value) {
    draft.value = null
    return
  }
  const { login, user } = original.value
  const quote = props.ws.dialect.quoteIdentifier
  let statements: string[]
  if (!login) statements = [`DROP USER ${quote(user!.name)}`]
  else {
    let dropUser = false
    if (user && !ownerUser.value) {
      const answer = await prompt({
        title: t('admin.logins.deleteLogin', { name: login.name }),
        fields: [{ key: 'user', type: 'checkbox', label: t('admin.logins.deleteUserToo', { user: user.name, database: database.value }), value: true }],
        okLabel: t('common.delete')
      })
      if (!answer) return
      dropUser = answer.user === true
    }
    statements = [...(dropUser ? [`DROP USER ${quote(user!.name)}`] : []), `DROP LOGIN ${quote(login.name)}`]
  }
  if (await reviewAndApply(props.ws, inTransaction(statements, 'BEGIN TRANSACTION'))) {
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
  const { login, user } = draft.value
  if (user && !user.name.trim() && login) user.name = login.name
  let statements: string[]
  try {
    statements = [
      ...(login ? loginStatements(original.value?.login ?? null, login, login.windows ? null : password.value || null) : []),
      ...userStatements(original.value?.user ?? null, user, login ? login.name : null)
    ]
  } catch (e) {
    error.value = (e as Error).message
    return
  }
  if (!statements.length) {
    error.value = t('admin.users.noChanges')
    return
  }
  if (await reviewAndApply(props.ws, inTransaction(statements, 'BEGIN TRANSACTION'))) {
    const name = login ? login.name : user!.name
    await loadLists()
    const entry = entries.value.find((e) => e.name === name && (e.kind === 'user') === !login)
    if (entry) await show(entry)
    else current.value = original.value = draft.value = null
  }
}

function toggle(list: string[], name: string, on: boolean): string[] {
  return on ? [...new Set([...list, name])] : list.filter((n) => n !== name)
}

function setState(permissions: Permissions, permission: string, state: string): Permissions {
  const out = { ...permissions }
  if (state) out[permission] = state as PermissionState
  else delete out[permission]
  return out
}

function schemaEntry(schema: string): Permissions {
  return draft.value?.user?.schemas.find((s) => s.schema === schema)?.permissions ?? {}
}

function setSchemaState(schema: string, permission: string, state: string): void {
  const user = draft.value?.user
  if (!user) return
  const permissions = setState(schemaEntry(schema), permission, state)
  const others = user.schemas.filter((s) => s.schema !== schema)
  user.schemas = Object.keys(permissions).length ? [...others, { schema, permissions }] : others
}

function setMapped(on: boolean): void {
  if (!draft.value) return
  draft.value.user = on ? (original.value?.user ? clone(original.value.user) : newUser('')) : null
}

function setPolicy(on: boolean): void {
  if (!draft.value?.login) return
  draft.value.login.checkPolicy = on
  if (!on) draft.value.login.checkExpiration = false
}

const checked = (e: Event): boolean => (e.target as HTMLInputElement).checked
const value = (e: Event): string => (e.target as HTMLSelectElement).value

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
        <div class="section-title">{{ t('admin.logins.listTitle') }}</div>
        <input v-model="filter" type="search" class="filter" :placeholder="t('admin.logins.filter')" />
        <div class="scroller">
          <table class="list">
            <thead>
              <tr>
                <th>{{ t('admin.logins.name') }}</th>
                <th>{{ t('admin.logins.type') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="isNew" class="selected new">
                <td>{{ draft?.login?.name ?? draft?.user?.name }}</td>
                <td>{{ kindLabels[draft?.login ? (draft.login.windows ? 'windows' : 'sql') : 'user'] }}</td>
              </tr>
              <tr
                v-for="e in visibleEntries"
                :key="`${e.kind}:${e.name}`"
                :class="{ selected: sameEntry(current, e) }"
                @mousedown="select(e)"
              >
                <td>{{ e.name }}</td>
                <td class="muted nowrap">{{ kindLabels[e.kind] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="buttons">
          <button :disabled="ws.busy" @click="add('login')">{{ t('admin.logins.addLogin') }}</button>
          <button :disabled="ws.busy" @click="add('user')">{{ t('admin.logins.addUser') }}</button>
        </div>
        <div class="buttons">
          <button :disabled="ws.busy || !draft" @click="remove">{{ t('common.delete') }}</button>
          <button :disabled="ws.busy" @click="refresh">{{ t('admin.refresh') }}</button>
        </div>
      </section>

      <section class="details">
        <template v-if="draft">
          <div class="section-title">{{ title }}</div>
          <div class="subtabs" role="tablist">
            <button
              v-for="id in detailTabs"
              :key="id"
              role="tab"
              :class="{ active: detailTab === id }"
              :aria-selected="detailTab === id"
              @click="detailTab = id"
            >
              {{ detailTabLabels[id] }}
            </button>
          </div>

          <div class="tab-body">
            <div v-if="detailTab === 'login' && draft.login" class="fields">
              <label for="ml-name">{{ t('admin.logins.loginName') }}</label>
              <input id="ml-name" v-model.trim="draft.login.name" type="text" spellcheck="false" />
              <span class="hint">{{ draft.login.windows ? t('admin.logins.windowsNameHint') : '' }}</span>

              <label for="ml-auth">{{ t('admin.logins.authentication') }}</label>
              <select id="ml-auth" v-model="draft.login.windows" :disabled="!isNew">
                <option :value="false">{{ t('admin.logins.authSql') }}</option>
                <option :value="true">{{ t('admin.logins.authWindows') }}</option>
              </select>
              <span class="hint" />

              <template v-if="!draft.login.windows">
                <label for="ml-pw">{{ t('admin.users.password') }}</label>
                <input id="ml-pw" v-model="password" type="password" autocomplete="new-password" />
                <span class="hint">{{ isNew ? t('admin.users.passwordHintNew') : t('admin.users.passwordHint') }}</span>

                <label for="ml-pw2">{{ t('admin.users.confirmPassword') }}</label>
                <input id="ml-pw2" v-model="confirmPassword" type="password" autocomplete="new-password" />
                <span class="hint">{{ t('admin.users.confirmPasswordHint') }}</span>

                <span />
                <label class="check">
                  <input type="checkbox" :checked="draft.login.checkPolicy" @change="setPolicy(checked($event))" />
                  {{ t('admin.logins.checkPolicy') }}
                </label>
                <span class="hint">{{ t('admin.logins.checkPolicyHint') }}</span>

                <span />
                <label class="check">
                  <input v-model="draft.login.checkExpiration" type="checkbox" :disabled="!draft.login.checkPolicy" />
                  {{ t('admin.logins.checkExpiration') }}
                </label>
                <span class="hint" />
              </template>

              <label for="ml-db">{{ t('admin.logins.defaultDatabase') }}</label>
              <select id="ml-db" v-model="draft.login.defaultDatabase">
                <option v-for="d in databases" :key="d" :value="d">{{ d }}</option>
              </select>
              <span class="hint" />

              <label for="ml-lang">{{ t('admin.logins.defaultLanguage') }}</label>
              <select id="ml-lang" v-model="draft.login.defaultLanguage">
                <option v-if="isNew" value="">{{ t('admin.logins.serverDefault') }}</option>
                <option v-for="l in languages" :key="l.name" :value="l.name">{{ l.name === l.alias ? l.name : `${l.name} (${l.alias})` }}</option>
              </select>
              <span class="hint" />

              <span />
              <label class="check">
                <input v-model="draft.login.disabled" type="checkbox" />
                {{ t('admin.logins.disabled') }}
              </label>
              <span class="hint">{{ t('admin.logins.disabledHint') }}</span>
            </div>

            <div v-else-if="detailTab === 'serverRoles' && draft.login" class="pane members">
              <label v-for="r in serverRoles" :key="r" class="check">
                <input type="checkbox" :checked="draft.login.serverRoles.includes(r)" @change="draft.login.serverRoles = toggle(draft.login.serverRoles, r, checked($event))" />
                {{ r }}
              </label>
            </div>

            <div v-else-if="detailTab === 'database'" class="schemas">
              <label v-if="draft.login" class="check">
                <input type="checkbox" :checked="!!draft.user" :disabled="ownerUser" @change="setMapped(checked($event))" />
                {{ t('admin.logins.mapUser', { database }) }}
              </label>
              <p v-else class="hint">{{ t('admin.logins.userWithoutLoginHint', { database }) }}</p>
              <p v-if="ownerUser" class="hint">{{ t('admin.logins.dboUser') }}</p>
              <template v-if="draft.user">
                <div class="fields">
                  <label for="ml-user">{{ t('admin.logins.userName') }}</label>
                  <input id="ml-user" v-model.trim="draft.user.name" type="text" spellcheck="false" :disabled="ownerUser" :placeholder="draft.login?.name" />
                  <span class="hint">{{ draft.login ? t('admin.logins.userNameHint') : '' }}</span>

                  <label for="ml-schema">{{ t('admin.logins.defaultSchema') }}</label>
                  <select id="ml-schema" v-model="draft.user.defaultSchema" :disabled="ownerUser">
                    <option value="">{{ t('admin.users.none') }}</option>
                    <option v-for="s in schemas" :key="s" :value="s">{{ s }}</option>
                  </select>
                  <span class="hint" />
                </div>
                <fieldset class="roles">
                  <legend>{{ t('admin.logins.databaseRoles') }}</legend>
                  <label v-for="r in databaseRoles" :key="r" class="check">
                    <input
                      type="checkbox"
                      :checked="draft.user.roles.includes(r)"
                      :disabled="ownerUser"
                      @change="draft.user.roles = toggle(draft.user.roles, r, checked($event))"
                    />
                    {{ r }}
                  </label>
                </fieldset>
              </template>
            </div>

            <div v-else-if="detailTab === 'permissions'" class="schemas">
              <p v-if="!draft.user" class="hint">{{ t('admin.logins.noUser', { database }) }}</p>
              <template v-else>
                <fieldset class="grid">
                  <legend>{{ t('admin.roles.database', { name: database }) }}</legend>
                  <label v-for="p in databasePermissions" :key="p" class="permission">
                    <span class="mono">{{ p }}</span>
                    <select
                      :value="draft.user.database[p] ?? ''"
                      :disabled="ownerUser"
                      @change="draft.user.database = setState(draft.user.database, p, value($event))"
                    >
                      <option v-for="[s, label] in states" :key="s" :value="s">{{ label }}</option>
                    </select>
                  </label>
                </fieldset>
                <div class="pane">
                  <table class="list">
                    <thead>
                      <tr>
                        <th>{{ t('admin.users.schema') }}</th>
                        <th v-for="p in schemaPermissions" :key="p">{{ p }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="s in schemas" :key="s">
                        <td class="mono">{{ s }}</td>
                        <td v-for="p in schemaPermissions" :key="p">
                          <select
                            :value="schemaEntry(s)[p] ?? ''"
                            :disabled="ownerUser"
                            :aria-label="t('admin.roles.privilegeOn', { privilege: p, schema: s })"
                            @change="setSchemaState(s, p, value($event))"
                          >
                            <option v-for="[st, label] in states" :key="st" :value="st">{{ label }}</option>
                          </select>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p class="hint">{{ t('admin.logins.permissionsHint') }}</p>
              </template>
            </div>
          </div>
        </template>
        <div v-else class="empty-state">{{ t('admin.logins.select') }}</div>

        <p v-if="error" class="error selectable">{{ error }}</p>
        <div class="actions">
          <button :disabled="!dirty || ws.busy" @click="show(current, draft?.login ? 'login' : 'user')">{{ t('common.revert') }}</button>
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
  width: 380px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}

.buttons {
  display: flex;
  gap: 6px;
  padding: 8px 10px 0;
}

.buttons:last-child {
  padding-bottom: 8px;
}

.nowrap {
  white-space: nowrap;
}

.fields > label:not(.check) {
  text-align: right;
  color: var(--text-muted);
}

.hint {
  color: var(--text-muted);
  font-size: var(--fs-small);
  margin: 0;
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
  margin: 0;
  padding: 6px 10px 8px;
}

fieldset.roles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 4px 14px;
}

fieldset.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 300px));
  gap: 4px 14px;
}

.permission {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
</style>
