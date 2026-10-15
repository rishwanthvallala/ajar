import java.util.regex.*;
import java.util.*;

public class Regex {
    public static void main(String[] args) {
        Pattern p = Pattern.compile("(\\w+)@(\\w+)\\.com");
        Matcher m = p.matcher("mail ada@example.com and bob@test.com now");
        while (m.find()) System.out.println(m.group() + " user=" + m.group(1) + " host=" + m.group(2) + " at " + m.start());
        System.out.println("2026-10-12".matches("\\d{4}-\\d{2}-\\d{2}") + " " + "a1b2c3".replaceAll("[0-9]", "#") + " " + "CamelCaseString".replaceAll("([A-Z])", "_$1").toLowerCase());
        Matcher named = Pattern.compile("(?<key>\\w+)=(?<val>\\d+)").matcher("x=1, y=22, z=333");
        List<String> kv = new ArrayList<>();
        while (named.find()) kv.add(named.group("key") + ":" + named.group("val"));
        System.out.println(kv + " " + Pattern.compile("\\s*,\\s*").splitAsStream("a , b,c ,d").toList());
        System.out.println(Pattern.compile("^hello", Pattern.CASE_INSENSITIVE | Pattern.MULTILINE).matcher("x\nHELLO there").find());
    }
}
