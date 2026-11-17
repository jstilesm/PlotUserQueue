#!/bin/sh
# CANCEL_CMD for plotpi: run after the plot feed has been killed.
# ESC.J clears a half-sent reply, ESC.K discards buffered HP-GL.
# The pause lets the plotter finish discarding before pen up and park,
# otherwise those bytes can arrive at a still-full buffer and be dropped.
# Serial settings copied from ~/itsaliveplot.
DEV="${PLOTTER_DEV:-/dev/ttyUSB0}"
stty -F "$DEV" 9600 raw -echo
printf '\033.J\033.K' > "$DEV"
sleep 1
printf 'PU;SP0;' > "$DEV"
echo "reset plotter on $DEV"
