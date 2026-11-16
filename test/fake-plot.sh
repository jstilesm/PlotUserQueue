#!/bin/sh
# Stands in for plot_task.sh on a machine with no plotter.
# Prints the file it was asked to plot, sleeps, and exits with FAKE_PLOT_EXIT.
echo "plotting $1"
sleep "${FAKE_PLOT_SECONDS:-5}"
exit "${FAKE_PLOT_EXIT:-0}"
