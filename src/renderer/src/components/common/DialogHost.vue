<script setup lang="ts">
import { dialogs } from '@/dialogs'
</script>

<template>
  <component :is="d.component" v-for="d in dialogs" :key="d.id" v-bind="d.props" @close="d.resolve" />
</template>
