<script lang="ts">
  import { BookOpen, CheckCircle, AlertTriangle, XCircle, Loader2, Square, Sparkles, Bell } from "lucide-svelte";
  import type { ChapterPrepProgress } from "@/entrypoints/content/chapter-prep";
  import { onMount, onDestroy } from "svelte";

  let progress = $state<ChapterPrepProgress>({
    status: "idle",
    discovered: 0,
    completed: 0,
    failed: 0,
    inFlight: 0,
    chapterTitle: "",
    message: "Pre-translate all chapter pages for uninterrupted reading.",
  });

  let notifyOnComplete = $state(true);

  function handleProgressEvent(e: Event) {
    const detail = (e as CustomEvent<ChapterPrepProgress>).detail;
    if (detail) {
      progress = detail;
    }
  }

  onMount(() => {
    document.addEventListener("lmt:chapter-prep-progress", handleProgressEvent);
    // Request current progress from manager
    document.dispatchEvent(new CustomEvent("lmt:chapter-prep-get"));
  });

  onDestroy(() => {
    document.removeEventListener("lmt:chapter-prep-progress", handleProgressEvent);
  });

  function startPreparation() {
    document.dispatchEvent(
      new CustomEvent("lmt:chapter-prep-start", {
        detail: { notify: notifyOnComplete },
      }),
    );
  }

  function stopPreparation() {
    document.dispatchEvent(new CustomEvent("lmt:chapter-prep-stop"));
  }

  let percent = $derived(
    progress.discovered > 0
      ? Math.min(
          100,
          Math.round(
            ((progress.completed + progress.failed) / progress.discovered) * 100,
          ),
        )
      : 0,
  );
</script>

<div class="panel-card !p-3 flex flex-col gap-2.5">
  <!-- Header & Status Badge -->
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-2 min-w-0">
      <div
        class="shrink-0 w-7 h-7 rounded-md border flex items-center justify-center bg-[var(--bg-void)] border-[var(--border-faint)] text-[var(--accent-cyan)]"
      >
        <BookOpen size={14} />
      </div>
      <div class="flex flex-col min-w-0">
        <span class="text-xs font-semibold leading-tight text-[var(--text-primary)]">
          Chapter Preparation
        </span>
        {#if progress.chapterTitle}
          <span class="text-[10px] text-[var(--text-dim)] truncate">
            {progress.chapterTitle}
          </span>
        {/if}
      </div>
    </div>

    <!-- Status Badge -->
    <div>
      {#if progress.status === "preparing"}
        <span
          class="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] border border-[var(--accent-cyan)]/40 animate-pulse"
        >
          <Loader2 size={10} class="animate-spin" />
          Preparing ({progress.completed}/{progress.discovered})
        </span>
      {:else if progress.status === "ready"}
        <span
          class="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
        >
          <CheckCircle size={10} />
          Ready ({progress.completed}/{progress.discovered})
        </span>
      {:else if progress.status === "partial"}
        <span
          class="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30"
        >
          <AlertTriangle size={10} />
          Partial ({progress.completed}/{progress.discovered})
        </span>
      {:else if progress.status === "failed"}
        <span
          class="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/30"
        >
          <XCircle size={10} />
          Failed
        </span>
      {:else}
        <span
          class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--surface-panel-alt)] text-[var(--text-dim)] border border-[var(--border-faint)]"
        >
          Idle
        </span>
      {/if}
    </div>
  </div>

  <!-- Message & Metrics -->
  <div class="text-[11px] text-[var(--text-muted)] leading-tight">
    {progress.message}
  </div>

  {#if progress.discovered > 0}
    <!-- Progress Bar -->
    <div class="w-full bg-[var(--bg-void)] h-1.5 rounded-full overflow-hidden border border-[var(--border-faint)]">
      <div
        class="h-full transition-all duration-300 {progress.status === 'ready'
          ? 'bg-emerald-500'
          : progress.status === 'partial'
            ? 'bg-amber-500'
            : progress.status === 'failed'
              ? 'bg-rose-500'
              : 'bg-[var(--accent-cyan)]'}"
        style="width: {percent}%;"
      ></div>
    </div>

    <!-- Truthful Metric Counters -->
    <div class="grid grid-cols-4 gap-1 py-1 px-1.5 bg-[var(--bg-void)] rounded border border-[var(--border-faint)] text-center text-[10px]">
      <div>
        <span class="text-[var(--text-dim)] block">Discovered</span>
        <span class="font-semibold text-[var(--text-primary)]">{progress.discovered}</span>
      </div>
      <div>
        <span class="text-[var(--text-dim)] block">Completed</span>
        <span class="font-semibold text-emerald-400">{progress.completed}</span>
      </div>
      <div>
        <span class="text-[var(--text-dim)] block">Failed</span>
        <span class="font-semibold {progress.failed > 0 ? 'text-rose-400' : 'text-[var(--text-muted)]'}">
          {progress.failed}
        </span>
      </div>
      <div>
        <span class="text-[var(--text-dim)] block">Time</span>
        <span class="font-semibold text-[var(--accent-cyan)]">
          {progress.elapsedSeconds !== undefined ? `${progress.elapsedSeconds}s` : "—"}
        </span>
      </div>
    </div>
  {/if}

  <!-- Options and Actions -->
  <div class="flex items-center justify-between pt-1">
    <label class="flex items-center gap-1.5 cursor-pointer text-[11px] text-[var(--text-dim)] hover:text-[var(--text-muted)]">
      <input
        type="checkbox"
        bind:checked={notifyOnComplete}
        class="w-3.5 h-3.5 rounded border-[var(--border-faint)] text-[var(--accent-cyan)] focus:ring-0 cursor-pointer"
      />
      <span class="flex items-center gap-1">
        <Bell size={10} /> Notify when ready
      </span>
    </label>

    {#if progress.status === "preparing"}
      <button
        type="button"
        onclick={stopPreparation}
        class="px-3 py-1.5 text-xs font-semibold rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm"
      >
        <Square size={11} /> Stop
      </button>
    {:else}
      <button
        type="button"
        onclick={startPreparation}
        class="px-3.5 py-1.5 text-xs font-semibold rounded-md border border-[var(--accent-cyan)]/40 bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/20 transition-all flex items-center gap-1.5 cursor-pointer shadow-sm hover:scale-[1.02] active:scale-[0.98]"
      >
        <Sparkles size={12} />
        {progress.status === "ready" ? "Re-prepare Chapter" : "Prepare Chapter"}
      </button>
    {/if}
  </div>
</div>
