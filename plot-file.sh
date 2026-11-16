#!/bin/sh
# plotq passes the HPGL path as $1; itsaliveplot wants the file on stdin.
exec "$HOME/itsaliveplot" < "$1"
