#!/usr/bin/env bash
set -u
timeout 5 ./run.sh # expect: sh-timeout
timeout -s KILL 10 ./run.sh # expect: sh-timeout
out="$(gtimeout 30 ./run.sh)" # expect: sh-timeout
./send-fixture.sh --timeout 60 # a flag of the command under test: not a hit
