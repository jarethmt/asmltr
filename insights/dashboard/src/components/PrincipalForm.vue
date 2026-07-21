<script setup>
// Create/edit modal for a principal (a trust-framework user). Create mode lets
// you set the id (the stable key); edit mode shows it read-only. Fields:
// id (create only), display_name, default_tier, revoked, notes. Submit ->
// trust store createPrincipal()/updatePrincipal().
import { computed, reactive, ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { useTrustStore } from '@/stores/trust'

const props = defineProps({
  principal: { type: Object, default: null } // present => edit mode
})
const emit = defineEmits(['close', 'saved'])

const store = useTrustStore()
const isEdit = computed(() => !!props.principal)

const form = reactive({
  id: isEdit.value ? props.principal.id : '',
  display_name: isEdit.value ? props.principal.display_name : '',
  default_tier: isEdit.value ? (props.principal.default_tier ?? 5) : 5,
  revoked: isEdit.value ? !!props.principal.revoked : false,
  notes: isEdit.value ? props.principal.notes || '' : ''
})

const submitting = ref(false)
const error = ref(null)

const canSubmit = computed(() => {
  if (form.display_name.trim() === '') return false
  if (!isEdit.value && form.id.trim() === '') return false
  return true
})

async function onSubmit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const payload = {
      display_name: form.display_name.trim(),
      default_tier: Number(form.default_tier),
      revoked: form.revoked,
      notes: form.notes.trim()
    }
    if (isEdit.value) {
      await store.updatePrincipal(props.principal.id, payload)
    } else {
      await store.createPrincipal({ id: form.id.trim(), ...payload })
    }
    emit('saved')
    emit('close')
  } catch (e) {
    error.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <ModalShell
    :title="isEdit ? 'Edit user' : 'Add user'"
    :subtitle="isEdit ? principal.id : 'new principal'"
    @close="emit('close')"
  >
    <form class="flex flex-col gap-5" @submit.prevent="onSubmit">
      <!-- id (create only) -->
      <div v-if="!isEdit">
        <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <span>User key (id)</span><span class="text-rose-400">*</span>
        </label>
        <input
          v-model="form.id"
          type="text"
          class="field-input font-mono"
          placeholder="e.g. alice"
        />
        <p class="mt-1 text-xs text-slate-500">Stable internal key — cannot be changed later.</p>
      </div>

      <!-- display name -->
      <div>
        <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <span>Display name</span><span class="text-rose-400">*</span>
        </label>
        <input
          v-model="form.display_name"
          type="text"
          class="field-input"
          placeholder="e.g. Jane Doe"
        />
      </div>

      <!-- default tier -->
      <div>
        <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <span>Default tier</span>
        </label>
        <input
          v-model.number="form.default_tier"
          type="number"
          min="0"
          class="field-input"
          placeholder="5"
        />
        <p class="mt-1 text-xs text-slate-500">Lower = more trusted (1 = partner, 0 = default-deny).</p>
      </div>

      <!-- revoked toggle -->
      <div class="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
        <div>
          <div class="text-sm font-medium text-slate-200">Revoked</div>
          <div class="text-xs text-slate-500">Access fully withdrawn — resolves to default-deny.</div>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="form.revoked"
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
          :class="form.revoked ? 'bg-rose-500' : 'bg-white/10'"
          @click="form.revoked = !form.revoked"
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
            :class="form.revoked ? 'translate-x-6' : 'translate-x-1'"
          ></span>
        </button>
      </div>

      <!-- notes -->
      <div>
        <label class="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <span>Notes</span>
        </label>
        <textarea
          v-model="form.notes"
          rows="3"
          class="field-input resize-y"
          placeholder="Context about this user…"
        ></textarea>
      </div>

      <p v-if="error" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
        {{ error }}
      </p>
    </form>

    <template #footer>
      <button
        type="button"
        class="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        type="button"
        :disabled="!canSubmit || submitting"
        class="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-brand-violet/30 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        @click="onSubmit"
      >
        {{ submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create user' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.field-input {
  @apply w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition-colors;
  @apply placeholder:text-slate-600 focus:border-brand-violet/60 focus:bg-white/[0.06];
}
</style>
