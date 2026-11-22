import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './styles/base.css'
import './editor/monaco'
import './editor/completion'
import App from './App.vue'

// eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- type of a .vue import, not read by typescript-eslint
createApp(App).use(createPinia()).mount('#app')
