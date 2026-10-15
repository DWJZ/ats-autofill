-- Mark READ inbox messages whose subject contains any given string as UNREAD (undo tool).
-- Usage: osascript mail_app_mark_unread.applescript "Career Workshops" "TitanHEALTH Flu Clinic"
-- CAVEAT: matching already-READ mail requires a broad `whose subject contains` query, which times out
-- (-1712) while Mail is busy (e.g. indexing at high CPU). The script prints the matched count per target;
-- if every call times out, wait for Mail to go idle and retry rather than changing approach.
on run argv
	tell application "Mail"
		with timeout of 120 seconds
			set report to ""
			repeat with t in argv
				set needle to (t as string)
				set n to 0
				try
					set msgs to (every message of inbox whose subject contains needle)
					repeat with m in msgs
						try
							set read status of m to false
							set n to n + 1
						end try
					end repeat
					set report to report & "matched+unread " & n & " for: " & needle & linefeed
				on error errMsg number errNum
					set report to report & "FAILED (" & errNum & ") for: " & needle & linefeed
				end try
			end repeat
			return report & "UNREAD NOW: " & (unread count of inbox)
		end timeout
	end tell
end run
