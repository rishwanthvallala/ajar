import java.time.*;
import java.time.format.*;
import java.time.temporal.*;

public class Time {
    public static void main(String[] args) {
        LocalDate d = LocalDate.of(2024, 2, 28).plusDays(1);
        System.out.println(d + " " + d.getDayOfWeek() + " leap=" + d.isLeapYear() + " " + d.lengthOfMonth() + " " + d.plusMonths(1).withDayOfMonth(1));
        System.out.println(ChronoUnit.DAYS.between(LocalDate.of(2000, 1, 1), LocalDate.of(2026, 10, 12)) + " " + Period.between(LocalDate.of(1990, 5, 17), LocalDate.of(2026, 10, 12)));
        LocalDateTime dt = LocalDateTime.of(2026, 10, 12, 14, 5, 9);
        System.out.println(dt.format(DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm:ss EEE")) + " " + dt.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME));
        System.out.println(Duration.ofMinutes(135).plusSeconds(7) + " " + Duration.between(dt, dt.plusHours(30)).toHours());
        ZonedDateTime z = ZonedDateTime.of(dt, ZoneId.of("America/New_York"));
        System.out.println(z + " -> " + z.withZoneSameInstant(ZoneId.of("Asia/Kolkata")) + " " + z.toInstant());
        System.out.println(LocalDate.parse("2026-12-25").getDayOfYear() + " " + YearMonth.of(2026, 2).lengthOfMonth() + " " + Instant.ofEpochSecond(1_000_000_000));
        System.out.println(LocalTime.of(23, 59).plusMinutes(2) + " " + DayOfWeek.MONDAY.plus(10) + " " + Month.FEBRUARY.maxLength());
    }
}
