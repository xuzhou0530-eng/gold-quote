#!/bin/bash
pkill -f "node.*server.js" 2>/dev/null
sleep 1
cd /Users/mac/Desktop/gold-quote
node server.js > /tmp/gold-quote.log 2>&1 &
echo "Server started on http://localhost:3456"
echo "Check logs: tail -f /tmp/gold-quote.log"
