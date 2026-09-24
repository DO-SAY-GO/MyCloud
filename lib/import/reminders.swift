// mycloud-reminders: print every reminder as JSON via EventKit (Reminders.app's scripting interface stalls on big lists).
import Foundation
import EventKit

let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { ok, _ in granted = ok; sema.signal() }
} else {
    store.requestAccess(to: .reminder) { ok, _ in granted = ok; sema.signal() }
}
sema.wait()
guard granted else {
    print("{\"denied\":true}")
    exit(0)
}

func stamp(_ d: Date?) -> Any { d.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull() }
func day(_ c: DateComponents?) -> Any {
    guard let c = c, let y = c.year, let m = c.month, let d = c.day else { return NSNull() }
    return String(format: "%04d-%02d-%02d", y, m, d)
}

var lists: [[String: Any]] = []
for cal in store.calendars(for: .reminder) {
    var items: [[String: Any]] = []
    let done = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: store.predicateForReminders(in: [cal])) { reminders in
        for r in reminders ?? [] {
            let due = r.dueDateComponents
            items.append([
                "id": r.calendarItemExternalIdentifier ?? r.calendarItemIdentifier,
                "title": r.title ?? "",
                "notes": r.notes ?? NSNull(),
                "completed": r.isCompleted,
                "completedAt": stamp(r.completionDate),
                "created": stamp(r.creationDate),
                "priority": r.priority,
                // A due date with no time of day is an all-day reminder.
                "dueDay": due != nil && due?.hour == nil ? day(due) : NSNull(),
                "due": due?.hour != nil ? stamp(due?.date ?? Calendar.current.date(from: due!)) : NSNull(),
            ])
        }
        done.signal()
    }
    done.wait()
    lists.append(["name": cal.title, "items": items])
}
let data = try! JSONSerialization.data(withJSONObject: ["lists": lists])
FileHandle.standardOutput.write(data)
