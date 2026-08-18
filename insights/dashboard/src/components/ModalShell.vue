<script setup>
// Minimal glass modal shell: backdrop + centered panel, header with title +
// close, scrollable body slot, optional footer slot. Closes on backdrop click
// and Escape. Shared by InstanceForm and LogsModal.
import { onMounted, onUnmounted } from 'vue'

defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  wide: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])

function onKey(e) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      @click.self="emit('close')"
    >
      <div
        class="glass my-auto w-full max-w-lg overflow-hidden"
        :class="wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'"
        @click.stop
      >
        <header class="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div class="min-w-0">
            <h2 class="text-lg font-bold tracking-tight">
              <span class="gradient-text">{{ title }}</span>
            </h2>
            <p v-if="subtitle" class="mt-0.5 truncate text-sm text-slate-400">{{ subtitle }}</p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-sm text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
            @click="emit('close')"
          >
            <AppIcon glyph="✕" />
          </button>
        </header>

        <div class="max-h-[70vh] overflow-y-auto px-5 py-4">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-4">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
