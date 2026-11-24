#!/bin/sh
# Stands in for the plot command on a machine with no plotter.
# Prints the file it was asked to plot, then writes a tick ten times a second
# for FAKE_PLOT_SECONDS (so a paused plot shows as a log that stops growing),
# and exits with FAKE_PLOT_EXIT.
# FAKE_PLOT_STALL_AFTER=n: after n ticks, go silent (keep running, write
# nothing), like a feeder stuck waiting on a plotter that stopped answering.
echo "plotting $1"
n=$(awk -v s="${FAKE_PLOT_SECONDS:-5}" 'BEGIN { printf "%d", s * 10 }')
i=0
while [ "$i" -lt "$n" ]; do
  if [ -n "$FAKE_PLOT_STALL_AFTER" ] && [ "$i" -ge "$FAKE_PLOT_STALL_AFTER" ]; then
    sleep 0.1
  else
    echo "tick $i"
    sleep 0.1
  fi
  i=$((i + 1))
done
exit "${FAKE_PLOT_EXIT:-0}"
