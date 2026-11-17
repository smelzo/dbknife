<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { Channel } from '@shared/types'
import { alertError } from '@/dialogs'
import { t } from '@/i18n'
import { useApp, withChannelCredentials } from '@/stores/app'
import Modal from '../common/Modal.vue'

/**
 * The dialog of a channel: a new one, or `channel` to edit (it keeps its id, so its saved
 * secrets and the connections using it stay valid). Resolves with the saved channel.
 */
const props = defineProps<{ channel?: Channel }>()
const emit = defineEmits<{ close: [saved?: Channel] }>()

const app = useApp()
const c = reactive<Channel>(
  props.channel ? { ...props.channel } : { id: crypto.randomUUID(), name: '', kind: 'ssh', host: '', port: 22, user: '', keyFile: '' }
)
const verifying = ref(false)

/** The hosts named in the OpenSSH configuration files; without any the dialog has only the manual settings. */
const configHosts = ref<string[]>([])
/** The host of that configuration the channel follows; empty for manual settings. */
const configHost = ref(props.channel?.configHost ?? '')
/** A host the channel was saved with and the files no longer name stays among the choices: the channel can still be edited. */
const hostChoices = computed(() => (configHost.value && !configHosts.value.includes(configHost.value) ? [configHost.value, ...configHosts.value] : configHosts.value))

onMounted(async () => {
  configHosts.value = await window.api.channels.configHosts()
})

async function chooseKeyFile(): Promise<void> {
  const path = await window.api.files.chooseOpen({ title: t('connection.selectFile') })
  if (path) c.keyFile = path
}

/** The channel is saved by the main process only once it works: a failure leaves the dialog open on the typed values. */
async function save(): Promise<void> {
  if (verifying.value) return
  verifying.value = true
  try {
    const host = c.host.trim()
    const user = c.user.trim()
    const alias = configHost.value
    // with a host of the configuration the manual settings do not count: they are not saved
    const channel: Channel = alias
      ? { id: c.id, name: c.name.trim() || alias, kind: 'ssh', host: '', port: 22, user: '', keyFile: '', configHost: alias }
      : { id: c.id, name: c.name.trim() || `${user}@${host}`, kind: 'ssh', host, port: Number(c.port) || 22, user, keyFile: c.keyFile.trim() }
    const r = await withChannelCredentials(channel, (creds) => window.api.channels.save(channel, creds))
    if (!r) return
    if (!r.ok) {
      await alertError(t('channel.verifyFailed', { name: channel.name }), r.error?.message)
      return
    }
    await app.loadChannels()
    emit('close', channel)
  } finally {
    verifying.value = false
  }
}

/** Not while verifying: the channel would be saved after the dialog has gone. */
function cancel(): void {
  if (!verifying.value) emit('close')
}
</script>

<template>
  <Modal :title="t(channel ? 'channel.titleEdit' : 'channel.titleNew')" width="520px" @cancel="cancel">
    <div class="form-grid">
      <label for="ch-name">{{ t('channel.name') }}</label>
      <input
        id="ch-name"
        v-model="c.name"
        type="text"
        autofocus
        :placeholder="configHost ? t('channel.namePlaceholderConfig', { host: configHost }) : t('channel.namePlaceholder')"
      />
      <template v-if="hostChoices.length">
        <label for="ch-config-host">{{ t('channel.configHost') }}</label>
        <select id="ch-config-host" v-model="configHost">
          <option value="">{{ t('channel.configHostManual') }}</option>
          <option v-for="host in hostChoices" :key="host" :value="host">{{ host }}</option>
        </select>
      </template>
      <template v-if="configHost">
        <span />
        <span class="muted">{{ t('channel.configHostNote') }}</span>
      </template>
      <template v-else>
        <label for="ch-host">{{ t('connection.sshHost') }}</label>
        <div class="row">
          <input id="ch-host" v-model="c.host" type="text" class="grow" />
          <label for="ch-port" class="inline">{{ t('connection.port') }}</label>
          <input id="ch-port" v-model.number="c.port" type="number" class="port" />
        </div>
        <label for="ch-user">{{ t('connection.sshUser') }}</label>
        <input id="ch-user" v-model="c.user" type="text" />
        <label for="ch-keyfile">{{ t('connection.sshKeyFile') }}</label>
        <div class="row">
          <input id="ch-keyfile" v-model="c.keyFile" type="text" class="grow" :placeholder="t('channel.keyFilePlaceholder')" />
          <button id="ch-keyfile-choose" @click="chooseKeyFile">…</button>
        </div>
      </template>
      <span />
      <span class="muted">{{ t('channel.note') }}</span>
    </div>
    <template #footer>
      <button id="ch-cancel" :disabled="verifying" @click="cancel">{{ t('common.cancel') }}</button>
      <button id="ch-ok" class="primary" :disabled="verifying || !(configHost || (c.host.trim() && c.user.trim()))" @click="save">
        {{ t(verifying ? 'channel.verifying' : 'common.ok') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
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
</style>
