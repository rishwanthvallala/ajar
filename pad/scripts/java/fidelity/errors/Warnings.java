import java.util.*;

public class Warnings {
    @SuppressWarnings("removal")
    public static void main(String[] args) {
        List raw = new ArrayList();
        raw.add("x");
        List<String> typed = raw;
        Integer boxed = new Integer(5);
        System.out.println(typed + " " + boxed);
    }
}
