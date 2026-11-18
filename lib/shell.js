"use strict";

/**
 * Generates static, zero-Node-startup shell hooks for zsh, bash, and fish.
 * Records per-pane command, exit code, duration, and cwd to a 0600 TSV file
 * inside a private per-user directory so users without Atuin get full pane context.
 *
 * Directory choice: $XDG_RUNTIME_DIR/piq when available (private by spec), otherwise
 * ${TMPDIR:-/tmp}/piq-$UID. The hook refuses to log if that directory is a symlink or
 * not owned by the current user: on a shared /tmp another user could pre-create it and
 * plant symlinks that would make the hook truncate or append to arbitrary files.
 */
function renderShellInit(shell) {
  if (shell === "zsh") {
    return `# piq per-pane shell hook (zsh)
# Recommended (0 ms startup — no node fork on new tabs):
#   mkdir -p ~/.config/piq && piq --init zsh > ~/.config/piq/init.zsh
#   # then add to ~/.zshrc:
#   [ -f ~/.config/piq/init.zsh ] && source ~/.config/piq/init.zsh
if [[ -o interactive ]]; then
  _piq_init_dir() {
    if [[ -n "$XDG_RUNTIME_DIR" && -d "$XDG_RUNTIME_DIR" && ! -L "$XDG_RUNTIME_DIR" && -O "$XDG_RUNTIME_DIR" ]]; then
      typeset -g _piq_dir="$XDG_RUNTIME_DIR/piq"
    else
      typeset -g _piq_dir="\${\${TMPDIR:-/tmp}%/}/piq-\${UID:-$(id -u)}"
    fi
    [[ -L "$_piq_dir" ]] && return 1
    [[ -d "$_piq_dir" ]] || command mkdir -m 700 "$_piq_dir" 2>/dev/null || return 1
    [[ -d "$_piq_dir" && ! -L "$_piq_dir" && -O "$_piq_dir" ]] || return 1
    command chmod 700 "$_piq_dir" 2>/dev/null
  }

  if _piq_init_dir; then
    export PIQ_PANE_LOG="$_piq_dir/pane-$$.tsv"
    ( umask 077; : >| "$PIQ_PANE_LOG" ) 2>/dev/null
    zmodload zsh/datetime 2>/dev/null
    autoload -Uz add-zsh-hook
    typeset -gi _piq_active=0 _piq_count=0
    typeset -g _piq_cmd="" _piq_start=""

    _piq_preexec() {
      _piq_cmd="$1"
      _piq_start="\${EPOCHREALTIME:-$SECONDS}"
      _piq_active=1
    }

    _piq_precmd() {
      local ec=$?
      (( _piq_active )) || return 0
      _piq_active=0
      [[ -n "$_piq_cmd" && -w "$PIQ_PANE_LOG" ]] || return 0
      local end="\${EPOCHREALTIME:-$SECONDS}"
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
  else
    unset PIQ_PANE_LOG
  fi
  unfunction _piq_init_dir 2>/dev/null
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
    _piq_init_dir() {
      if [[ -n "\${XDG_RUNTIME_DIR:-}" && -d "$XDG_RUNTIME_DIR" && ! -L "$XDG_RUNTIME_DIR" && -O "$XDG_RUNTIME_DIR" ]]; then
        _piq_dir="$XDG_RUNTIME_DIR/piq"
      else
        _piq_dir="\${TMPDIR:-/tmp}"
        _piq_dir="\${_piq_dir%/}/piq-\${UID:-$(id -u)}"
      fi
      [[ -L "$_piq_dir" ]] && return 1
      [[ -d "$_piq_dir" ]] || command mkdir -m 700 "$_piq_dir" 2>/dev/null || return 1
      [[ -d "$_piq_dir" && ! -L "$_piq_dir" && -O "$_piq_dir" ]] || return 1
      command chmod 700 "$_piq_dir" 2>/dev/null
    }

    if _piq_init_dir; then
      export PIQ_PANE_LOG="$_piq_dir/pane-$$.tsv"
      ( umask 077; : >| "$PIQ_PANE_LOG" ) 2>/dev/null
      _piq_count=0
      _piq_init_hist=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)
      _piq_last_num="\${_piq_init_hist#"\${_piq_init_hist%%[![:space:]]*}"}"
      _piq_last_num="\${_piq_last_num%%[[:space:]]*}"
      unset _piq_init_hist

      _piq_prompt_cmd() {
        local ec=$?
        local line num cmd ts_ms
        line=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)
        line="\${line#"\${line%%[![:space:]]*}"}"
        num="\${line%%[[:space:]]*}"
        if [ -n "$num" ] && [ "$num" != "$_piq_last_num" ] && [ -w "$PIQ_PANE_LOG" ]; then
          _piq_last_num="$num"
          cmd="\${line#"$num"}"
          cmd="\${cmd#"\${cmd%%[![:space:]]*}"}"
          cmd="\${cmd//$'\\t'/ }"
          cmd="\${cmd//$'\\n'/; }"
          if [ -n "$cmd" ]; then
            ts_ms="\${EPOCHSECONDS:-$(date +%s)}000"
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
        PROMPT_COMMAND="_piq_prompt_cmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
      fi
    else
      unset PIQ_PANE_LOG
    fi
    unset -f _piq_init_dir
    ;;
esac
`;
  }

  if (shell === "fish") {
    return `# piq per-pane shell hook (fish)
# Recommended (0 ms startup — no node fork on new tabs):
#   mkdir -p ~/.config/fish/conf.d && piq --init fish > ~/.config/fish/conf.d/piq.fish
if status is-interactive
  if set -q XDG_RUNTIME_DIR; and test -n "$XDG_RUNTIME_DIR" -a -d "$XDG_RUNTIME_DIR" -a ! -L "$XDG_RUNTIME_DIR" -a -O "$XDG_RUNTIME_DIR"
    set -g _piq_dir "$XDG_RUNTIME_DIR/piq"
  else
    set -l _piq_tmp /tmp
    set -q TMPDIR; and test -n "$TMPDIR"; and set _piq_tmp (string replace -r '/+$' '' -- "$TMPDIR")
    set -g _piq_dir "$_piq_tmp/piq-"(id -u)
  end

  if not test -L "$_piq_dir"
    and begin; test -d "$_piq_dir"; or command mkdir -m 700 "$_piq_dir" 2>/dev/null; end
    and test -d "$_piq_dir" -a ! -L "$_piq_dir" -a -O "$_piq_dir"
    and command chmod 700 "$_piq_dir" 2>/dev/null

    set -gx PIQ_PANE_LOG "$_piq_dir/pane-$fish_pid.tsv"
    command sh -c 'umask 077 && : > "$1"' _ "$PIQ_PANE_LOG" 2>/dev/null
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
  else
    set -e PIQ_PANE_LOG
  end
end
`;
  }

  throw new Error(`Unsupported shell "${shell}". Expected zsh, bash, or fish.`);
}

module.exports = {
  renderShellInit,
};
