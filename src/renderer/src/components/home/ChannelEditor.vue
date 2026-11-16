<script setup lang="ts">
import { reactive, ref } from 'vue'
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
    const channel: Channel = { ...c, host, user, port: Number(c.port) || 22, keyFile: c.keyFile.trim(), name: c.name.trim() || `${user}@${host}` }
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
      <input id="ch-name" v-model="c.name" type="text" autofocus :placeholder="t('channel.namePlaceholder')" />
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
      <span />
      <span class="muted">{{ t('channel.note') }}</span>
    </div>
    <template #footer>
      <button id="ch-cancel" :disabled="verifying" @click="cancel">{{ t('common.cancel') }}</button>
      <button id="ch-ok" class="primary" :disabled="verifying || !c.host.trim() || !c.user.trim()" @click="save">
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
