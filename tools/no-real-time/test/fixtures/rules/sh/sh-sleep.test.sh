#!/usr/bin/env bash
# sleep 1 in a comment is not a hit.
set -u
start_server &
sleep 1 # expect: sh-sleep
sleep 0.2; check # expect: sh-sleep
( sleep "$delay" ) # expect: sh-sleep
until ready; do sleep 1; done # expect: sh-sleep
echo "going to sleep now" # prose in a string: not a hit
