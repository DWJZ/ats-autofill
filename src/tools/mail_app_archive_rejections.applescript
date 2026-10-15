-- Archive REJECTIONS ONLY, by reading each candidate's BODY.
--
-- WHY THIS EXISTS (2026-10-09, user request): "把拒信 archive, 只处理 .edu 邮箱的". The sibling tool
-- (mail_app_archive.applescript) moves whole SUBJECT FAMILIES, and the families are mixed. In the .edu inbox
-- `Your application for` matches 89 messages of which 21 are receipts ("We've received your application for ...")
-- and the rest are rejections - the same wording, from the same ATS, for opposite meanings. Moving the family
-- would have answered the standing request of 2026-10-08 ("拒信和申请的自动回复都 archive") and ignored the new one
-- ("拒信"), so this tool asks the body instead of the subject.
--
-- IT IS DRY BY DEFAULT. Without `--move` it prints what it WOULD move and touches nothing. The sibling tool is the
-- only other one here that moves a message; this one decides on evidence one step further from certain (a phrase
-- inside a body), so it reports first and moves only when told to. Every line names the phrase that decided it,
-- because a verdict nobody can check is a verdict nobody should trust.
--
-- WHAT THE FIRST RUN TAUGHT THE MARKERS (2026-10-09, all three cost a wrong verdict before they were fixed):
--   * APOSTROPHES. Mail bodies use the TYPOGRAPHIC ’ while a phrase list typed by hand carries '. "won’t be
--     moving forward" therefore matched nothing, and five Pinterest rejections fell through to the weak bucket.
--     `normalise` folds ’ and ‘ to ' before any comparison.
--   * "availab" is not an action marker: it matches "should a position become available" in Wealthfront's
--     REJECTION, which then could not be moved. Availability is only asked for directly ("your availability").
--   * "next round of interviews" is not an action marker either - it is what a rejection says was denied
--     ("wasn't selected for the next round of interviews", Appian). Interview wording counts only when it INVITES.
--   * "invite you to" is not one either: it is marketing boilerplate in a third of the mail ("we invite you to
--     join our Talent Community", "we invite you to continue your search"), and on one Pinterest message it
--     masked a real rejection - "will not be moving forward with your candidacy ... we invite you to review future
--     job openings". An invitation counts only when it names what it invites you TO.
--
-- ACTION BEATS EVERYTHING ELSE, so a message that invites the user to schedule, assess, interview or sign is
-- never moved, whatever else it says. The Pavago/Spark Hire video invitation paid for that rule: it stayed in the
-- inbox while 1,670 messages were archived around it.
--
-- THE VERDICTS:
--   REJECTION      a phrase that can only end an application. This is what --move moves.
--   REJECTION-WEAK only "unfortunately" - often real, never proof on its own (the phrase above it was promoted to
--                  strong only after reading the SAP bodies: "we regret to inform you that we have chosen to pursue
--                  other applicants" is not ambiguous). Reported and left alone.
--   RECEIPT        "we've received your application", "has been received", "thank you for applying", ...
--   ACTION         something is being asked of the user - never moved
--   UNKNOWN        no marker either way (an image-only body has no text at all) - left alone and reported
--
-- Usage:
--   osascript mail_app_archive_rejections.applescript --account "csu.fairview.edu" "Your application for" ...
--   osascript mail_app_archive_rejections.applescript --account "csu.fairview.edu" --move "Your application for" ...
--   (--account narrows to accounts whose address contains the string; without it EVERY account is scanned, which
--    is how the sibling tool behaves and is NOT what "只处理 .edu 邮箱的" asked for.)
on normalise(bodyText)
	set savedDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to "’"
	set chunks to text items of bodyText
	set AppleScript's text item delimiters to "'"
	set bodyText to chunks as string
	set AppleScript's text item delimiters to "‘"
	set chunks to text items of bodyText
	set AppleScript's text item delimiters to "'"
	set bodyText to chunks as string
	set AppleScript's text item delimiters to savedDelims
	return bodyText
end normalise

on classify(rawText)
	set bodyText to my normalise(rawText)
	set actionPhrases to {"invite you to interview", "invite you to schedule", "invite you to a call", ¬
		"invite you to the next", "invite you to speak", "invite you to complete", "schedule a call", "schedule an interview", ¬
		"scheduling a call", "phone screen", "set up a time", "your availability", "availability for a", ¬
		"take-home", "take home assignment", "coding challenge", "assessment", "offer letter", "extend an offer", ¬
		"background check", "reference check", "would like to move forward with you"}
	set strongRejections to {"not to move forward", "not moving forward", "won't be moving forward", ¬
		"will not be moving forward", "decided not to move forward", "move forward with other candidates", ¬
		"moving forward with other candidates", "move forward with other applicants", "not to proceed", ¬
		"will not be proceeding", "unable to move forward", "cannot move forward", "has been filled", ¬
		"pursue other candidates", "pursue other applicants", "regret to inform", "not selected", "wasn't selected", ¬
		"isn't an ideal fit", ¬
		"there isn't an ideal fit", "other candidates whose experience", "not able to provide any kind of visa support", ¬
		"best of luck in your search", "best in your job search", "success in your job search", ¬
		"all the best in your search", "wish you the best", "not be able to offer you", ¬
		"no longer under consideration", "decided to move forward with other"}
	set weakRejections to {"unfortunately"}
	set receiptPhrases to {"received your application", "received your resume", "has been received", ¬
		"thank you for applying", "thanks for applying", "thank you for your interest", "we appreciate your interest", ¬
		"application is in good hands", "will be reviewing your", "successfully submitted", ¬
		"we have your application", "keep your application on file", "your application is complete", ¬
		"application was received", "under review"}
	repeat with phraseItem in actionPhrases
		if bodyText contains (phraseItem as string) then return {"ACTION", phraseItem as string}
	end repeat
	repeat with phraseItem in strongRejections
		if bodyText contains (phraseItem as string) then return {"REJECTION", phraseItem as string}
	end repeat
	repeat with phraseItem in weakRejections
		if bodyText contains (phraseItem as string) then return {"REJECTION-WEAK", phraseItem as string}
	end repeat
	repeat with phraseItem in receiptPhrases
		if bodyText contains (phraseItem as string) then return {"RECEIPT", phraseItem as string}
	end repeat
	return {"UNKNOWN", "-"}
end classify

on run argv
	set argList to argv as list
	if (count of argList) = 0 then return "usage: mail_app_archive_rejections.applescript --account <substring> [--move] <needle> [more needles...]"
	set acctFilter to ""
	set doMove to false
	set needles to {}
	set i to 1
	repeat while i is less than or equal to (count of argList)
		set a to (item i of argList) as string
		if a is "--move" then
			set doMove to true
			set i to i + 1
		else if a is "--account" then
			if i < (count of argList) then
				set acctFilter to (item (i + 1) of argList) as string
				set i to i + 2
			else
				return "REFUSED: --account needs a value"
			end if
		else
			set end of needles to a
			set i to i + 1
		end if
	end repeat
	if (count of needles) = 0 then return "REFUSED: no subject needles given"

	tell application "Mail"
		with timeout of 1800 seconds
			set reportText to ""
			set movedCount to 0
			repeat with acct in accounts
				set acctName to (user name of acct)
				set acctAddrs to (email addresses of acct as string)
				if acctFilter is "" or acctAddrs contains acctFilter then
					-- Resolve this account's archive and inbox mailboxes BY NAME, the way the sibling tool has to:
					-- `mailbox "All Mail" of account 1` is refused with -1728 even though the name is listed. The
					-- localized names are here because two accounts carry them (所有邮件, 存档) and the LSU account
					-- carries a localized EMPTY 收件箱 beside its real Inbox - hence "the first one that holds mail".
					set dest to missing value
					set src to missing value
					repeat with bx in mailboxes of acct
						set nm to (name of bx)
						if nm is "All Mail" or nm is "Archive" or nm is "所有邮件" or nm is "存档" or nm is "归档" then set dest to bx
						if nm is "INBOX" or nm is "收件箱" then
							try
								if (count of messages of bx) > 0 and src is missing value then set src to bx
							end try
						end if
					end repeat
					if dest is missing value or src is missing value then
						set reportText to reportText & "(SKIPPED " & acctName & ": inbox or archive mailbox not resolved)" & linefeed
					else
						repeat with needleItem in needles
							set needle to (needleItem as string)
							if (length of needle) < 12 then
								set reportText to reportText & "REFUSED (needle too short to be safe): " & needle & linefeed
							else
								try
									set hits to (every message of src whose read status is true and subject contains needle)
									repeat with theMsg in hits
										set bodyText to ""
										try
											set bodyText to content of theMsg
											if (length of bodyText) > 4000 then set bodyText to (text 1 thru 4000 of bodyText)
										end try
										set verdictParts to my classify(bodyText)
										set verdict to item 1 of verdictParts
										set phraseHit to item 2 of verdictParts
										set subjText to subject of theMsg
										if (length of subjText) > 82 then set subjText to (text 1 thru 82 of subjText)
										set sndrText to sender of theMsg
										if (length of sndrText) > 34 then set sndrText to (text 1 thru 34 of sndrText)
										set reportText to reportText & "[" & verdict & " :: " & phraseHit & "] " & (date received of theMsg as string) & " | " & sndrText & " | " & subjText & linefeed
										if verdict is "REJECTION" and doMove then
											try
												move theMsg to dest
												set movedCount to movedCount + 1
												set reportText to reportText & "        -> MOVED to " & (name of dest) & linefeed
											on error errMsg number errNum
												set reportText to reportText & "        -> MOVE FAILED (" & errNum & ")" & linefeed
											end try
										end if
									end repeat
								on error errMsg number errNum
									set reportText to reportText & "FAILED (" & errNum & ") in " & acctName & " for: " & needle & linefeed
								end try
							end if
						end repeat
					end if
				end if
			end repeat
			set reportText to reportText & "MOVED: " & (movedCount as string) & "   DRY RUN: " & ((not doMove) as string) & linefeed
			return reportText
		end timeout
	end tell
end run
