import java.util.*;

public class Types {
    static int half(int n) {
        if (n > 0) return n / 2;
    }
    public static void main(String[] args) {
        int x = "seven";
        String s = 5;
        long big = 1L;
        int small = big;
        List<String> names = new ArrayList<>();
        names.add(3);
        Object o = names;
        String t = o;
    }
}
