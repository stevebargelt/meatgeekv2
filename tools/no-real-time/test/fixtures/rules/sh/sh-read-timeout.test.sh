#!/usr/bin/env bash
set -u
read -t 5 line < "$fifo" # expect: sh-read-timeout
read -r -t 1 ready <&3 # expect: sh-read-timeout
IFS= read -rt 2 reply # expect: sh-read-timeout
read -r line < "$fifo" # no deadline: not a hit
