"use strict";

/**
 * Generates static, zero-Node-startup shell hooks for zsh, bash, and fish.
 * Records per-pane command, exit code, duration, and cwd to a 0600 TSV file
 * inside a 0700 per-UID directory so users without Atuin get full pane context.
 */
function renderShellInit(shell) {
  if (shell === "zsh") {
    return `# piq per-pane shell hook (zsh)
# Recommended (0 ms startup — no node fork on new tabs):
#   mkdir -p ~/.config/piq && piq --init zsh > ~/.config/piq/init.zsh
#   # then add to ~/.zshrc:
#   [ -f ~/.config/piq/init.zsh ] && source ~/.config/piq/init.zsh
if [[ -o interactive ]]; then
  zmodload zsh/datetime 2>/dev/null
  autoload -Uz add-zsh-hook
  typeset -g _piq_dir="\${TMPDIR:-/tmp}/piq-\${UID:-\$(id -u)}"
  export PIQ_PANE_LOG="\${_piq_dir}/pane-$$.tsv"
  command sh -c 'umask 077 && mkdir -p -m 700 "$1" && : > "$2"' _ "$_piq_dir" "$PIQ_PANE_LOG" 2>/dev/null
  typeset -gi _piq_active=0 _piq_count=0
  typeset -g _piq_cmd="" _piq_start=""

  _piq_preexec() {
    _piq_cmd="$1"
    _piq_start="\${EPOCHREALTIME:-\$SECONDS}"
    _piq_active=1
  }

  _piq_precmd() {
    local ec=$?
    (( _piq_active )) || return 0
    _piq_active=0
    [[ -n "$_piq_cmd" && -w "$PIQ_PANE_LOG" ]] || return 0
    local end="\${EPOCHREALTIME:-\$SECONDS}"
    integer ts_ms=$(( \${end%.*} * 1000 ))
    integer dur_ms=-1
    if [[ -n "$_piq_start" ]]; then
      integer d_ms=$(( (end - _piq_start) * 1000 ))
      (( d_ms < 0 )) && d_ms=0
      dur_ms=$d_ms
    fi
    local clean="\${_piq_cmd//$'\\t'/ }"
    clean="\${clean//$'\\n'/; }"
    print -r -- "\${ts_ms}\t\${dur_ms}\t\${ec}\t\${PWD}\t\${clean}" >> "$PIQ_PANE_LOG" 2>/dev/null
    if (( ++_piq_count % 40 == 0 )); then
      command tail -n 20 "$PIQ_PANE_LOG" > "\${PIQ_PANE_LOG}.tmp" 2>/dev/null && command mv -f "\${PIQ_PANE_LOG}.tmp" "$PIQ_PANE_LOG" 2>/dev/null
    fi
  }

  _piq_zshexit() {
    (( ZSH_SUBSHELL == 0 )) && command rm -f "$PIQ_PANE_LOG" "\${PIQ_PANE_LOG}.tmp" 2>/dev/null
  }

  add-zsh-hook preexec _piq_preexec
  add-zsh-hook precmd _piq_precmd
  add-zsh-hook zshexit _piq_zshexit
fi
`;
  }

  if (shell === "bash") {
    return `# piq per-pane shell hook (bash)
# Recommended (0 ms startup — no node fork on new tabs):
#   mkdir -p ~/.config/piq && piq --init bash > ~/.config/piq/init.bash
#   # then add to ~/.bashrc:
#   [ -f ~/.config/piq/init.bash ] && source ~/.config/piq/init.bash
case "$-" in
  *i*)
    _piq_dir="\${TMPDIR:-/tmp}/piq-\${UID:-\$(id -u)}"
    export PIQ_PANE_LOG="\${_piq_dir}/pane-$$.tsv"
    command sh -c 'umask 077 && mkdir -p -m 700 "$1" && : > "$2"' _ "$_piq_dir" "$PIQ_PANE_LOG" 2>/dev/null
    _piq_count=0
    _piq_init_hist=\$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)
    _piq_last_num="\${_piq_init_hist#"\${_piq_init_hist%%[![:space:]]*}"}"
    _piq_last_num="\${_piq_last_num%%[[:space:]]*}"
    unset _piq_init_hist

    _piq_prompt_cmd() {
      local ec=$?
      local line num cmd ts_ms
      line=\$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)
      line="\${line#"\${line%%[![:space:]]*}"}"
      num="\${line%%[[:space:]]*}"
      if [ -n "$num" ] && [ "$num" != "$_piq_last_num" ] && [ -w "$PIQ_PANE_LOG" ]; then
        _piq_last_num="$num"
        cmd="\${line#"$num"}"
        cmd="\${cmd#"\${cmd%%[![:space:]]*}"}"
        cmd="\${cmd//$'\\t'/ }"
        cmd="\${cmd//$'\\n'/; }"
        if [ -n "$cmd" ]; then
          ts_ms="\${EPOCHSECONDS:-\$(date +%s)}000"
          printf '%s\\t-1\\t%s\\t%s\\t%s\\n' "$ts_ms" "$ec" "$PWD" "$cmd" >> "$PIQ_PANE_LOG" 2>/dev/null
          _piq_count=$(( _piq_count + 1 ))
          if [ $(( _piq_count % 40 )) -eq 0 ]; then
            command tail -n 20 "$PIQ_PANE_LOG" > "\${PIQ_PANE_LOG}.tmp" 2>/dev/null && command mv -f "\${PIQ_PANE_LOG}.tmp" "$PIQ_PANE_LOG" 2>/dev/null
          fi
        fi
      fi
      return "$ec"
    }

    trap '[ "\${BASH_SUBSHELL:-0}" -eq 0 ] && command rm -f "$PIQ_PANE_LOG" "\${PIQ_PANE_LOG}.tmp" 2>/dev/null' EXIT

    if declare -p PROMPT_COMMAND 2>/dev/null | grep -q 'declare -a'; then
      PROMPT_COMMAND=(_piq_prompt_cmd "\${PROMPT_COMMAND[@]}")
    else
      PROMPT_COMMAND="_piq_prompt_cmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
    fi
    ;;
esac
`;
  }

  if (shell === "fish") {
    return `# piq per-pane shell hook (fish)
# Recommended (0 ms startup — no node fork on new tabs):
#   mkdir -p ~/.config/fish/conf.d && piq --init fish > ~/.config/fish/conf.d/piq.fish
if status is-interactive
  set -g _piq_dir (set -q TMPDIR; and echo $TMPDIR; or echo /tmp)"/piq-"(id -u)
  set -gx PIQ_PANE_LOG "$_piq_dir/pane-$fish_pid.tsv"
  command sh -c 'umask 077 && mkdir -p -m 700 "$1" && : > "$2"' _ "$_piq_dir" "$PIQ_PANE_LOG" 2>/dev/null
  set -g _piq_count 0

  function _piq_postexec --on-event fish_postexec
    set -l ec $status
    set -l dur $CMD_DURATION
    test -z "$dur"; and set dur -1
    set -l cmd (string replace -a \\t ' ' -- "$argv[1]" | string replace -a \\n '; ')
    test -n "$cmd" -a -w "$PIQ_PANE_LOG"; or return 0
    set -l ts_ms (math (date +%s)" * 1000")
    printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$ts_ms" "$dur" "$ec" "$PWD" "$cmd" >> "$PIQ_PANE_LOG" 2>/dev/null
    set -g _piq_count (math $_piq_count + 1)
    if test (math "$_piq_count % 40") -eq 0
      command tail -n 20 "$PIQ_PANE_LOG" > "$PIQ_PANE_LOG.tmp" 2>/dev/null; and command mv -f "$PIQ_PANE_LOG.tmp" "$PIQ_PANE_LOG" 2>/dev/null
    end
  end

  function _piq_exit --on-event fish_exit
    command rm -f "$PIQ_PANE_LOG" "$PIQ_PANE_LOG.tmp" 2>/dev/null
  end
end
`;
  }

  throw new Error(`Unsupported shell "${shell}". Expected zsh, bash, or fish.`);
}

module.exports = {
  renderShellInit,
};
