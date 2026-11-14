<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { ConnectionConfig, ConnectionEnvironment, Engine, SecretKind } from '@shared/types'
import { sqliteExtensions } from '@shared/file-types'
import { alertError, prompt } from '@/dialogs'
import { t } from '@/i18n'
import { environmentLabel, withCredentials } from '@/stores/app'
import { engineLabels } from '@/workspace/engines'
import Modal from '../common/Modal.vue'

/** The "Setup New Connection" dialog. Resolves with the saved config. */
const props = defineProps<{ config: ConnectionConfig; isNew: boolean }>()
const emit = defineEmits<{ close: [saved?: ConnectionConfig] }>()

const c = reactive<ConnectionConfig>(JSON.parse(JSON.stringify(props.config)))
const page = ref<'parameters' | 'ssl' | 'advanced'>('parameters')
const testing = ref(false)
const stored = ref<Record<SecretKind, boolean>>({ password: false, ssh: false, sshPassphrase: false })

const environments: ConnectionEnvironment[] = ['production', 'staging', 'test', 'development']

const defaults: Record<Exclude<Engine, 'sqlite'>, { port: number; user: string }> = {
  mysql: { port: 3306, user: 'root' },
  postgres: { port: 5432, user: 'postgres' },
  mssql: { port: 1433, user: 'sa' }
}

/** Switching engine replaces the other engine's default port and user, and the methods it lacks. */
function setEngine(engine: Engine): void {
  const previous = c.engine
  c.engine = engine
  if (engine !== 'sqlite' && previous !== 'sqlite') {
    if (c.port === defaults[previous].port) c.port = defaults[engine].port
    if (c.user === defaults[previous].user) c.user = defaults[engine].user
  }
  if (engine !== 'mysql' && c.method === 'socket') c.method = 'tcp'
  if (engine === 'sqlite') page.value = 'parameters'
}

/** "None" leaves no environment field in the saved config. */
function setEnvironment(value: string): void {
  if (value) c.environment = value as ConnectionEnvironment
  else delete c.environment
}

void window.api.secrets.status(c.id).then((s) => (stored.value = s))

async function storeSecret(kind: 'password' | 'ssh'): Promise<void> {
  const ssh = kind === 'ssh'
  const r = await prompt({
    title: t('connection.storeSecret.title'),
    message: t(ssh ? 'connection.storeSecret.sshPasswordMessage' : 'connection.storeSecret.passwordMessage', { user: ssh ? c.ssh.user : c.user }),
    fields: [{ key: 'v', label: t(ssh ? 'app.credentials.sshPassword' : 'app.credentials.password'), type: 'password' }]
  })
  if (!r) return
  if (!(await window.api.secrets.set(c.id, kind, String(r.v)))) {
    await alertError(t('connection.storeSecret.failed'), t('connection.storeSecret.noEncryption'))
    return
  }
  stored.value = await window.api.secrets.status(c.id)
}

async function clearSecrets(): Promise<void> {
  await window.api.secrets.clear(c.id)
  stored.value = await window.api.secrets.status(c.id)
}

async function chooseFile(target: 'ca' | 'cert' | 'key' | 'sshKey' | 'database'): Promise<void> {
  const path = await window.api.files.chooseOpen({ title: t(target === 'database' ? 'connection.selectDatabase' : 'connection.selectFile') })
  if (!path) return
  if (target === 'sshKey') c.ssh.keyFile = path
  else if (target === 'database') c.file = path
  else c.ssl[target] = path
}

async function newDatabaseFile(): Promise<void> {
  const path = await window.api.files.chooseSave({
    title: t('connection.newDatabase'),
    defaultPath: 'database.sqlite',
    filters: [{ name: t('connection.sqliteDatabases'), extensions: sqliteExtensions }]
  })
  if (path) c.file = path
}

const snapshot = (): ConnectionConfig => JSON.parse(JSON.stringify(c))

/** A PostgreSQL or SQL Server session is bound to one database: it must be named. */
async function missingDatabase(): Promise<boolean> {
  if ((c.engine !== 'postgres' && c.engine !== 'mssql') || c.database.trim()) return false
  page.value = 'parameters'
  await alertError(t('connection.databaseRequired'), t('connection.databaseRequiredDetail', { engine: engineLabels[c.engine] }))
  return true
}

async function test(): Promise<void> {
  if (await missingDatabase()) return
  testing.value = true
  try {
    const config = snapshot()
    const r = await withCredentials(config, (creds) => window.api.db.test(config, creds))
    if (!r) return
    const label = engineLabels[config.engine]
    if (r.ok) {
      const detail =
        config.engine === 'sqlite'
          ? t('connection.test.sqliteDetail', { file: config.file, version: r.info?.version ?? '' })
          : t('connection.test.serverDetail', {
              host: config.host,
              port: config.port,
              user: config.user,
              ssl: r.info?.ssl || t('connection.test.sslOff'),
              version: r.info?.version ?? ''
            })
      await window.api.ui.message({ type: 'info', message: t('connection.test.success', { engine: label }), detail })
    } else {
      await alertError(t('connection.test.failed', { engine: label }), r.error?.message)
    }
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  if (await missingDatabase()) return
  if (!c.name.trim()) {
    c.name = c.engine === 'sqlite' ? (c.file.split('/').pop() ?? 'SQLite') : c.method === 'socket' ? t('connection.socketName') : `${c.user}@${c.host}`
  }
  const config = snapshot()
  await window.api.connections.save(config)
  emit('close', config)
}

async function cancel(): Promise<void> {
  // secrets typed for a connection that is never saved must not linger
  if (props.isNew) await window.api.secrets.clear(c.id)
  emit('close')
}
</script>

<template>
  <Modal :title="t(isNew ? 'connection.titleNew' : 'connection.titleEdit')" width="640px" @cancel="cancel">
    <div class="form-grid top">
      <label for="ce-name">{{ t('connection.name') }}</label>
      <input id="ce-name" v-model="c.name" type="text" autofocus :placeholder="t('connection.namePlaceholder')" />
      <label for="ce-environment">{{ t('connection.environment') }}</label>
      <select id="ce-environment" :value="c.environment ?? ''" @change="setEnvironment(($event.target as HTMLSelectElement).value)">
        <option value="">{{ t('connection.environment.none') }}</option>
        <option v-for="e in environments" :key="e" :value="e">{{ environmentLabel(e) }}</option>
      </select>
      <label for="ce-engine">{{ t('connection.engine') }}</label>
      <select id="ce-engine" :value="c.engine" @change="setEngine(($event.target as HTMLSelectElement).value as Engine)">
        <option value="mysql">MySQL / MariaDB</option>
        <option value="postgres">PostgreSQL</option>
        <option value="mssql">SQL Server</option>
        <option value="sqlite">SQLite</option>
      </select>
      <template v-if="c.engine !== 'sqlite'">
        <label for="ce-method">{{ t('connection.method') }}</label>
        <select id="ce-method" v-model="c.method">
          <option value="tcp">{{ t('connection.methodTcp') }}</option>
          <option v-if="c.engine === 'mysql'" value="socket">{{ t('connection.methodSocket') }}</option>
          <option value="ssh">{{ t('connection.methodSsh') }}</option>
        </select>
      </template>
    </div>
    <div class="pages">
      <button :class="{ active: page === 'parameters' }" @click="page = 'parameters'">{{ t('connection.parameters') }}</button>
      <template v-if="c.engine !== 'sqlite'">
        <button :class="{ active: page === 'ssl' }" @click="page = 'ssl'">SSL</button>
        <button :class="{ active: page === 'advanced' }" @click="page = 'advanced'">{{ t('connection.advanced') }}</button>
      </template>
    </div>
    <div class="page-box">
      <div v-if="page === 'parameters' && c.engine === 'sqlite'" class="form-grid">
        <label for="ce-file">{{ t('connection.file') }}</label>
        <div class="row">
          <input id="ce-file" v-model="c.file" type="text" class="grow" :placeholder="t('connection.filePlaceholder')" />
          <button :title="t('connection.chooseDatabase')" @click="chooseFile('database')">…</button>
          <button :title="t('connection.createDatabase')" @click="newDatabaseFile">{{ t('connection.newFile') }}</button>
        </div>
        <span />
        <span class="muted">{{ t('connection.fileCreated') }}</span>
      </div>
      <div v-else-if="page === 'parameters'" class="form-grid">
        <template v-if="c.method === 'ssh'">
          <label for="ce-sshhost">{{ t('connection.sshHost') }}</label>
          <input id="ce-sshhost" v-model="c.ssh.host" type="text" :placeholder="t('connection.sshHostPlaceholder')" />
          <label for="ce-sshuser">{{ t('connection.sshUser') }}</label>
          <input id="ce-sshuser" v-model="c.ssh.user" type="text" />
          <label>{{ t('connection.sshPassword') }}</label>
          <div class="row">
            <button @click="storeSecret('ssh')">{{ t('connection.storeInKeychain') }}</button>
            <span class="muted">{{ t(stored.ssh ? 'connection.secret.stored' : 'connection.secret.notStored') }}</span>
          </div>
          <label for="ce-sshkey">{{ t('connection.sshKeyFile') }}</label>
          <div class="row">
            <input id="ce-sshkey" v-model="c.ssh.keyFile" type="text" class="grow" :placeholder="t('connection.sshKeyPlaceholder')" />
            <button @click="chooseFile('sshKey')">…</button>
          </div>
        </template>
        <template v-if="c.method === 'socket'">
          <label for="ce-socket">{{ t('connection.socketPath') }}</label>
          <input id="ce-socket" v-model="c.socket" type="text" />
        </template>
        <template v-else>
          <label for="ce-host">{{ c.method === 'ssh' ? t('connection.engineHost', { engine: engineLabels[c.engine] }) : t('connection.host') }}</label>
          <div class="row">
            <input id="ce-host" v-model="c.host" type="text" class="grow" />
            <label for="ce-port" class="inline">{{ t('connection.port') }}</label>
            <input id="ce-port" v-model.number="c.port" type="number" class="port" />
          </div>
          <template v-if="c.engine === 'mssql'">
            <span />
            <span class="muted">{{ t('connection.mssqlInstanceNote') }}</span>
          </template>
        </template>
        <label for="ce-user">{{ t('connection.user') }}</label>
        <input id="ce-user" v-model="c.user" type="text" />
        <template v-if="c.engine === 'mssql'">
          <span />
          <span class="muted">{{ t('connection.mssqlWindowsNote') }}</span>
        </template>
        <label>{{ t('connection.password') }}</label>
        <div class="row">
          <button @click="storeSecret('password')">{{ t('connection.storeInKeychain') }}</button>
          <button :disabled="!stored.password && !stored.ssh" @click="clearSecrets">{{ t('common.clear') }}</button>
          <span class="muted">{{
            t(stored.password ? 'connection.secret.stored' : c.workbenchKeychain ? 'connection.secret.workbench' : 'connection.secret.asked')
          }}</span>
        </div>
        <template v-if="c.engine === 'postgres' || c.engine === 'mssql'">
          <label for="ce-database">{{ t('connection.database') }}</label>
          <input id="ce-database" v-model="c.database" type="text" :placeholder="t('connection.databasePlaceholder')" />
        </template>
        <!-- SQL Server: the default schema belongs to the database user -->
        <template v-if="c.engine !== 'mssql'">
          <label for="ce-schema">{{ t('connection.defaultSchema') }}</label>
          <input id="ce-schema" v-model="c.defaultSchema" type="text" :placeholder="t('connection.defaultSchemaPlaceholder')" />
        </template>
      </div>
      <div v-else-if="page === 'ssl'" class="form-grid">
        <label for="ce-ssl">{{ t('connection.ssl.use') }}</label>
        <select id="ce-ssl" v-model="c.ssl.mode">
          <option value="disabled">{{ t('connection.ssl.disabled') }}</option>
          <option value="preferred">{{ t('connection.ssl.preferred') }}</option>
          <option value="required">{{ t('connection.ssl.required') }}</option>
          <option value="verify_ca">{{ t('connection.ssl.verifyCa') }}</option>
          <option value="verify_identity">{{ t('connection.ssl.verifyIdentity') }}</option>
        </select>
        <!-- SQL Server takes no client certificate -->
        <template v-for="f in c.engine === 'mssql' ? (['ca'] as const) : (['ca', 'cert', 'key'] as const)" :key="f">
          <label :for="`ce-${f}`">{{ t('connection.ssl.file', { file: f.toUpperCase() }) }}</label>
          <div class="row">
            <input :id="`ce-${f}`" v-model="c.ssl[f]" type="text" class="grow" />
            <button @click="chooseFile(f)">…</button>
          </div>
        </template>
        <template v-if="c.engine === 'mysql'">
          <label for="ce-cipher">{{ t('connection.ssl.cipher') }}</label>
          <input id="ce-cipher" v-model="c.ssl.cipher" type="text" :placeholder="t('connection.ssl.cipherPlaceholder')" />
        </template>
      </div>
      <div v-else class="form-grid">
        <template v-if="c.engine === 'mysql'">
          <span />
          <label class="check left"><input v-model="c.options.compress" type="checkbox" /> {{ t('connection.compress') }}</label>
        </template>
        <label for="ce-timeout">{{ t('connection.timeout') }}</label>
        <div class="row"><input id="ce-timeout" v-model.number="c.options.connectTimeout" type="number" class="port" /> <span class="muted">{{ t('connection.seconds') }}</span></div>
        <template v-if="c.engine === 'mysql'">
          <label for="ce-mode">SQL_MODE:</label>
          <input id="ce-mode" v-model="c.options.sqlMode" type="text" :placeholder="t('connection.sqlModePlaceholder')" />
        </template>
      </div>
    </div>
    <template #footer>
      <button class="test" :disabled="testing" @click="test">{{ t(testing ? 'connection.testing' : 'connection.test.button') }}</button>
      <button @click="cancel">{{ t('common.cancel') }}</button>
      <button class="primary" @click="save">{{ t('common.ok') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.top {
  margin-bottom: 12px;
}

.pages {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}

.pages button {
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 5px 5px 0 0;
  background: transparent;
}

.pages button.active {
  background: var(--bg-content);
  border-color: var(--border);
  font-weight: 600;
}

.page-box {
  background: var(--bg-content);
  border: 1px solid var(--border);
  border-top: none;
  padding: 14px;
  min-height: 250px;
}

.row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.grow {
  flex: 1;
}

.port {
  width: 80px;
}

.inline {
  color: var(--text-muted);
}

.left {
  text-align: left !important;
}

.test {
  margin-right: auto;
}
</style>
