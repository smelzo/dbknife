<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Row } from '@shared/types'
import { valueText } from '@shared/value-text'
import {
  accountName,
  accountStatements,
  adminRoles,
  collectPrivileges,
  passwordlessPlugins,
  privilegeCatalog,
  type Account,
  type PrivilegeCatalog
} from '@shared/sql/accounts'
import type { Workspace } from '@/workspace/workspace'
import { reviewAndApply } from '@/workspace/review'
import { confirm, openDialog } from '@/dialogs'
import { t } from '@/i18n'
import SchemaEntryDialog from './SchemaEntryDialog.vue'
import type { AdminTab } from './admin'

/** Users and Privileges: accounts on the left, the selected account's details on the right. */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

interface AccountRef {
  user: string
  host: string
}

type DetailTab = 'login' | 'limits' | 'roles' | 'schemas'
const detailTabs: [DetailTab, string][] = [
  ['login', t('admin.users.tabLogin')],
  ['limits', t('admin.users.tabLimits')],
  ['roles', t('admin.users.tabRoles')],
  ['schemas', t('admin.users.tabSchemas')]
]

const objectRights = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'SHOW VIEW', 'DELETE HISTORY', 'SHOW CREATE ROUTINE']
const ddlRights = ['CREATE', 'ALTER', 'REFERENCES', 'INDEX', 'CREATE VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'DROP', 'TRIGGER']

const isMariaDB = computed(() => !!props.ws.info?.isMariaDB)
const accounts = ref<AccountRef[]>([])
const filter = ref('')
/** Account shown in the details, null while a new account is being defined. */
const current = ref<AccountRef | null>(null)
const original = ref<Account | null>(null)
const draft = ref<Account | null>(null)
const password = ref('')
const confirmPassword = ref('')
const detailTab = ref<DetailTab>('login')
const selectedEntry = ref<string | null>(null)
const catalog = ref<PrivilegeCatalog>({ global: [], schema: [] })
const plugins = ref<string[]>([])
const error = ref('')

async function q(sql: string, params?: unknown[]): Promise<Row[]> {
  const r = await window.api.db.query(props.ws.sessionId, sql, params)
  if (r.error) throw new Error(r.error.message)
  return r.rows
}

const clone = (a: Account): Account => JSON.parse(JSON.stringify(a))
const sameAccount = (a: AccountRef | null, b: AccountRef): boolean => !!a && a.user === b.user && a.host === b.host
const globalNames = computed(() => catalog.value.global.map((p) => p.name))

/** Privileges in catalog order, unknown ones last, so equal sets compare equal. */
const ordered = (names: string[], known: string[]): string[] => [
  ...known.filter((p) => names.includes(p)),
  ...names.filter((p) => !known.includes(p))
]

const visibleAccounts = computed(() => {
  const f = filter.value.trim().toLowerCase()
  return f ? accounts.value.filter((a) => `${a.user}@${a.host}`.toLowerCase().includes(f)) : accounts.value
})

const isNew = computed(() => !!draft.value && !current.value)
const dirty = computed(
  () =>
    !!draft.value &&
    (isNew.value || !!password.value || !!confirmPassword.value || JSON.stringify(draft.value) !== JSON.stringify(original.value))
)
const pluginOptions = computed(() => {
  const p = draft.value?.plugin
  return p && !plugins.value.includes(p) ? [...plugins.value, p] : plugins.value
})
const needsPassword = computed(() => !!draft.value && !passwordlessPlugins.has(draft.value.plugin))

function defaultPlugin(): string {
  return ['caching_sha2_password', 'mysql_native_password'].find((p) => plugins.value.includes(p)) ?? plugins.value[0] ?? ''
}

async function loadCatalog(): Promise<void> {
  catalog.value = privilegeCatalog((await q('SHOW PRIVILEGES')) as { Privilege: string; Context: string; Comment: string }[])
  const rows = await q(
    "SELECT PLUGIN_NAME AS name FROM information_schema.PLUGINS WHERE PLUGIN_TYPE = 'AUTHENTICATION' AND PLUGIN_STATUS = 'ACTIVE' ORDER BY PLUGIN_NAME"
  )
  plugins.value = rows.map((r) => String(r.name))
}

async function loadAccounts(): Promise<void> {
  const roles = isMariaDB.value ? " WHERE IFNULL(is_role, 'N') <> 'Y'" : ''
  const rows = await q(`SELECT User AS user, Host AS host FROM mysql.user${roles} ORDER BY User, Host`)
  accounts.value = rows.map((r) => ({ user: String(r.user), host: String(r.host) }))
}

async function loadAccount(a: AccountRef): Promise<Account> {
  const [u] = await q(
    `SELECT plugin, max_questions AS maxQueries, max_updates AS maxUpdates, max_connections AS maxConnections,
      max_user_connections AS maxUserConnections FROM mysql.user WHERE User = ? AND Host = ?`,
    [a.user, a.host]
  )
  if (!u) throw new Error(t('admin.users.accountGone', { account: `${a.user}@${a.host}` }))
  // information_schema writes grantees as 'user'@'host' without escaping
  const grantee = `'${a.user}'@'${a.host}'`
  const globals = await q(
    'SELECT PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?',
    [grantee]
  )
  const schemaRows = await q(
    `SELECT TABLE_SCHEMA AS name, PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable
      FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ? ORDER BY TABLE_SCHEMA`,
    [grantee]
  )
  const bySchema = new Map<string, { privilege: string; grantable: string }[]>()
  for (const r of schemaRows) {
    const name = String(r.name)
    if (!bySchema.has(name)) bySchema.set(name, [])
    bySchema.get(name)!.push({ privilege: String(r.privilege), grantable: String(r.grantable) })
  }
  const privileges = (rows: Row[]): { privilege: string; grantable: string }[] =>
    rows.map((r) => ({ privilege: String(r.privilege), grantable: String(r.grantable) }))
  return {
    user: a.user,
    host: a.host,
    // old MariaDB accounts have an empty plugin, meaning the native one
    plugin: valueText(u.plugin || 'mysql_native_password'),
    limits: {
      maxQueries: Number(u.maxQueries),
      maxUpdates: Number(u.maxUpdates),
      maxConnections: Number(u.maxConnections),
      maxUserConnections: Number(u.maxUserConnections)
    },
    privileges: ordered(collectPrivileges(privileges(globals)), globalNames.value),
    schemas: [...bySchema].map(([schema, rows]) => ({
      schema,
      privileges: ordered(collectPrivileges(rows), catalog.value.schema)
    }))
  }
}

function blankAccount(): Account {
  return {
    user: 'newuser',
    host: '%',
    plugin: defaultPlugin(),
    limits: { maxQueries: 0, maxUpdates: 0, maxConnections: 0, maxUserConnections: 0 },
    privileges: [],
    schemas: []
  }
}

/** Shows an account (null: a new one) in the details, discarding any edit. */
async function show(a: AccountRef | null): Promise<void> {
  error.value = ''
  password.value = confirmPassword.value = ''
  selectedEntry.value = null
  try {
    const account = a ? await loadAccount(a) : blankAccount()
    current.value = a
    original.value = a ? account : null
    draft.value = clone(account)
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function canDiscard(): Promise<boolean> {
  return !dirty.value || (await confirm(t('admin.users.discardAccount'), undefined, t('admin.users.discard')))
}

async function select(a: AccountRef): Promise<void> {
  if (sameAccount(current.value, a) || !(await canDiscard())) return
  await show(a)
}

async function addAccount(): Promise<void> {
  if (!(await canDiscard())) return
  await show(null)
  detailTab.value = 'login'
}

async function refresh(): Promise<void> {
  if (!(await canDiscard())) return
  error.value = ''
  try {
    await loadAccounts()
    const still = current.value && accounts.value.find((a) => sameAccount(current.value, a))
    if (still) await show(still)
    else if (current.value) current.value = original.value = draft.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function removeAccount(): Promise<void> {
  if (!current.value) {
    draft.value = null
    return
  }
  const { user, host } = current.value
  if (await reviewAndApply(props.ws, [`DROP USER ${accountName(user, host)}`])) {
    current.value = original.value = draft.value = null
    await loadAccounts()
  }
}

async function expirePassword(): Promise<void> {
  if (!current.value) return
  await reviewAndApply(props.ws, [`ALTER USER ${accountName(current.value.user, current.value.host)} PASSWORD EXPIRE`])
}

function revert(): void {
  void show(current.value)
}

async function apply(): Promise<void> {
  if (!draft.value) return
  error.value = ''
  if (password.value !== confirmPassword.value) {
    error.value = t('admin.users.passwordMismatch')
    return
  }
  // a cleared number input yields ''
  const limits = draft.value.limits
  for (const k of Object.keys(limits) as (keyof typeof limits)[]) limits[k] = Math.max(0, Math.trunc(Number(limits[k]) || 0))
  let statements: string[]
  try {
    statements = accountStatements(original.value, draft.value, isNew.value || password.value ? password.value : null, {
      isMariaDB: isMariaDB.value
    })
  } catch (e) {
    error.value = (e as Error).message
    return
  }
  if (!statements.length) {
    error.value = t('admin.users.noChanges')
    return
  }
  if (await reviewAndApply(props.ws, statements)) {
    const target = { user: draft.value.user, host: draft.value.host }
    await loadAccounts()
    await show(target)
  }
}

// --- privileges -------------------------------------------------------------

function setPrivileges(list: string[], names: string[], on: boolean, known: string[]): string[] {
  const set = new Set(list)
  for (const n of names) {
    if (on) set.add(n)
    else set.delete(n)
  }
  return ordered([...set], known)
}

function toggleGlobal(names: string[], on: boolean): void {
  if (draft.value) draft.value.privileges = setPrivileges(draft.value.privileges, names, on, globalNames.value)
}

const roleRows = computed(() =>
  adminRoles.map((role) => {
    const privileges = role.privileges === 'all' ? globalNames.value : role.privileges.filter((p) => globalNames.value.includes(p))
    const granted = !!draft.value && privileges.length > 0 && privileges.every((p) => draft.value!.privileges.includes(p))
    return { ...role, privileges, granted }
  })
)

const entry = computed(() => draft.value?.schemas.find((s) => s.schema === selectedEntry.value))
const schemaGroups = computed(() => {
  const all = catalog.value.schema
  return [
    { title: t('admin.users.objectRights'), names: objectRights.filter((p) => all.includes(p)) },
    { title: t('admin.users.ddlRights'), names: ddlRights.filter((p) => all.includes(p)) },
    { title: t('admin.users.otherRights'), names: all.filter((p) => !objectRights.includes(p) && !ddlRights.includes(p)) }
  ]
})

/** Title of the selected entry's rights, split around the {schema} placeholder shown in monospace. */
const rightsTitle = computed(() =>
  draft.value ? t('admin.users.schemaRights', { account: `'${draft.value.user}'@'${draft.value.host}'` }).split(/(\{schema\})/) : []
)

function toggleSchema(names: string[], on: boolean): void {
  if (entry.value) entry.value.privileges = setPrivileges(entry.value.privileges, names, on, catalog.value.schema)
}

async function addEntry(): Promise<void> {
  if (!draft.value) return
  const schemas = props.ws.meta.schemas.length ? props.ws.meta.schemas : await props.ws.meta.loadSchemas()
  const schema = await openDialog<string>(SchemaEntryDialog, { schemas })
  if (!schema) return
  if (!draft.value.schemas.some((s) => s.schema === schema)) draft.value.schemas.push({ schema, privileges: [] })
  selectedEntry.value = schema
}

function deleteEntry(): void {
  if (!draft.value || !entry.value) return
  draft.value.schemas = draft.value.schemas.filter((s) => s !== entry.value)
  selectedEntry.value = null
}

onMounted(async () => {
  try {
    await loadCatalog()
    await loadAccounts()
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
        <div class="section-title">{{ t('admin.users.userAccounts') }}</div>
        <input v-model="filter" type="search" class="filter" :placeholder="t('admin.users.filter')" />
        <div class="scroller">
          <table class="list">
            <thead>
              <tr><th>{{ t('admin.users.user') }}</th><th>{{ t('admin.users.fromHost') }}</th></tr>
            </thead>
            <tbody>
              <tr v-if="isNew" class="selected new">
                <td>{{ draft?.user }}</td>
                <td>{{ draft?.host }}</td>
              </tr>
              <tr
                v-for="a in visibleAccounts"
                :key="`${a.user}@${a.host}`"
                :class="{ selected: sameAccount(current, a) }"
                @mousedown="select(a)"
              >
                <td>{{ a.user }}</td>
                <td>{{ a.host }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="buttons">
          <button :disabled="ws.busy" @click="addAccount">{{ t('admin.users.addAccount') }}</button>
          <button :disabled="ws.busy || !draft" @click="removeAccount">{{ t('common.delete') }}</button>
          <button :disabled="ws.busy" @click="refresh">{{ t('admin.refresh') }}</button>
        </div>
      </section>

      <section class="details">
        <template v-if="draft">
          <div class="section-title">
            {{ isNew ? t('admin.users.detailsNew') : t('admin.users.details', { account: `${current?.user}@${current?.host}` }) }}
          </div>
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
              <label for="up-user">{{ t('admin.users.loginName') }}</label>
              <input id="up-user" v-model="draft.user" type="text" />
              <span class="hint">{{ t('admin.users.loginNameHint') }}</span>

              <label for="up-plugin">{{ t('admin.users.authType') }}</label>
              <select id="up-plugin" v-model="draft.plugin">
                <option v-for="p in pluginOptions" :key="p" :value="p">{{ p }}</option>
              </select>
              <span class="hint">
                {{ needsPassword ? t('admin.users.authTypeHint') : t('admin.users.authTypeNoPassword') }}
              </span>

              <label for="up-host">{{ t('admin.users.hostMatching') }}</label>
              <input id="up-host" v-model="draft.host" type="text" />
              <span class="hint">{{ t('admin.users.hostMatchingHint') }}</span>

              <label for="up-pw">{{ t('admin.users.password') }}</label>
              <input id="up-pw" v-model="password" type="password" :disabled="!needsPassword" autocomplete="new-password" />
              <span class="hint">{{ isNew ? t('admin.users.passwordHintNew') : t('admin.users.passwordHint') }}</span>

              <label for="up-pw2">{{ t('admin.users.confirmPassword') }}</label>
              <input id="up-pw2" v-model="confirmPassword" type="password" :disabled="!needsPassword" autocomplete="new-password" />
              <span class="hint">{{ t('admin.users.confirmPasswordHint') }}</span>

              <span />
              <div><button :disabled="isNew || ws.busy" @click="expirePassword">{{ t('admin.users.expirePassword') }}</button></div>
              <span class="hint">{{ t('admin.users.expirePasswordHint') }}</span>
            </div>

            <div v-else-if="detailTab === 'limits'" class="fields">
              <label for="up-mq">{{ t('admin.users.maxQueries') }}</label>
              <input id="up-mq" v-model.number="draft.limits.maxQueries" type="number" min="0" />
              <span class="hint">{{ t('admin.users.maxQueriesHint') }}</span>

              <label for="up-mu">{{ t('admin.users.maxUpdates') }}</label>
              <input id="up-mu" v-model.number="draft.limits.maxUpdates" type="number" min="0" />
              <span class="hint">{{ t('admin.users.maxUpdatesHint') }}</span>

              <label for="up-mc">{{ t('admin.users.maxConnections') }}</label>
              <input id="up-mc" v-model.number="draft.limits.maxConnections" type="number" min="0" />
              <span class="hint">{{ t('admin.users.maxConnectionsHint') }}</span>

              <label for="up-muc">{{ t('admin.users.concurrentConnections') }}</label>
              <input id="up-muc" v-model.number="draft.limits.maxUserConnections" type="number" min="0" />
              <span class="hint">{{ t('admin.users.concurrentConnectionsHint') }}</span>

              <span />
              <span class="hint wide">{{ t('admin.users.noLimit') }}</span>
            </div>

            <div v-else-if="detailTab === 'roles'" class="roles">
              <div class="pane">
                <table class="list">
                  <thead>
                    <tr><th /><th>{{ t('admin.users.role') }}</th><th>{{ t('admin.users.description') }}</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in roleRows" :key="r.name">
                      <td>
                        <input
                          type="checkbox"
                          :checked="r.granted"
                          :aria-label="r.name"
                          @change="toggleGlobal(r.privileges, ($event.target as HTMLInputElement).checked)"
                        />
                      </td>
                      <td>{{ r.name }}</td>
                      <td class="muted">{{ r.description }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="pane privileges">
                <div class="pane-title">{{ t('admin.users.globalPrivileges') }}</div>
                <label v-for="p in catalog.global" :key="p.name" class="check" :title="p.comment">
                  <input
                    type="checkbox"
                    :checked="draft.privileges.includes(p.name)"
                    @change="toggleGlobal([p.name], ($event.target as HTMLInputElement).checked)"
                  />
                  {{ p.name }}
                </label>
              </div>
            </div>

            <div v-else class="schemas">
              <div class="entries">
                <div class="pane">
                  <table class="list">
                    <thead>
                      <tr><th>{{ t('admin.users.schema') }}</th><th>{{ t('admin.users.privileges') }}</th></tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="s in draft.schemas"
                        :key="s.schema"
                        :class="{ selected: s.schema === selectedEntry }"
                        @mousedown="selectedEntry = s.schema"
                      >
                        <td class="mono">{{ s.schema }}</td>
                        <td class="privs">{{ s.privileges.join(', ') || t('admin.users.none') }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="side-buttons">
                  <button @click="addEntry">{{ t('admin.users.addEntry') }}</button>
                  <button :disabled="!entry" @click="deleteEntry">{{ t('admin.users.deleteEntry') }}</button>
                </div>
              </div>
              <div v-if="entry" class="rights">
                <div class="pane-title">
                  <template v-for="(part, i) in rightsTitle" :key="i">
                    <span v-if="part === '{schema}'" class="mono">{{ entry.schema }}</span>
                    <template v-else>{{ part }}</template>
                  </template>
                </div>
                <div class="groups">
                  <fieldset v-for="g in schemaGroups" :key="g.title">
                    <legend>{{ g.title }}</legend>
                    <label v-for="p in g.names" :key="p" class="check">
                      <input
                        type="checkbox"
                        :checked="entry.privileges.includes(p)"
                        @change="toggleSchema([p], ($event.target as HTMLInputElement).checked)"
                      />
                      {{ p }}
                    </label>
                  </fieldset>
                  <div class="side-buttons">
                    <button @click="toggleSchema(catalog.schema, true)">{{ t('admin.users.selectAll') }}</button>
                    <button @click="toggleSchema(catalog.schema, false)">{{ t('admin.users.unselectAll') }}</button>
                  </div>
                </div>
              </div>
              <p v-else class="muted">{{ t('admin.users.selectEntry') }}</p>
            </div>
          </div>
        </template>
        <div v-else class="empty-state">{{ t('admin.users.selectAccount') }}</div>

        <p v-if="error" class="error selectable">{{ error }}</p>
        <div class="actions">
          <button :disabled="!dirty || ws.busy" @click="revert">{{ t('common.revert') }}</button>
          <button class="primary" :disabled="!dirty || ws.busy" @click="apply">{{ t('common.apply') }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped src="./accounts.css"></style>

<style scoped>
.section-title,
.pane-title {
  font-weight: 600;
  padding: 8px 10px 6px;
}

.pane-title {
  padding: 0 0 6px;
}

.accounts {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}

.accounts td {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
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

.hint.wide {
  grid-column: span 2;
}

.roles {
  display: flex;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

.roles > .pane:first-child {
  flex: 1;
}

.roles td:last-child {
  white-space: normal;
}

.privileges .pane-title {
  position: sticky;
  top: -8px;
  background: var(--bg-content);
}

.privileges {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px;
}

.entries {
  display: flex;
  gap: 10px;
}

.entries .pane {
  flex: 1;
  height: 160px;
}

td.privs {
  white-space: normal;
}

.side-buttons {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.groups {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

fieldset {
  border: 1px solid var(--border);
  border-radius: 5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 6px 10px 8px;
  min-width: 170px;
}
</style>
