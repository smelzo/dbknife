import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './styles/base.css'
import './editor/monaco'
import './editor/completion'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
